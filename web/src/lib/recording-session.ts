import { api, errorMessage, type Meeting, type TranscriptSegment, type ProcessingState } from "./meetings"
import { PcmRecorder } from "./pcm-recorder"

type Action = "start" | "pause" | "resume" | "end"
interface Snapshot {
  meeting: Meeting | null
  busy: boolean
  finishing: boolean
  localRecording: boolean
  error: string
  notice: string
  partialText: string
  liveVersion: number
  durationUpdatedAt: number
}
interface ServerMessage {
  type: string
  meeting_id: string
  action?: Action
  meeting?: Meeting
  text?: string
  message?: string
  fatal?: boolean
  segment_id?: number
  revision?: number
  next_segment_id?: number
  upsert_segments?: TranscriptSegment[]
  remove_segment_ids?: number[]
  speakers?: Meeting["speakers"]
  processing?: ProcessingState
}

// Owns microphone and socket lifetimes independently of React renders.
export class RecordingSession {
  private snapshot: Snapshot = {
    meeting: null,
    busy: false,
    finishing: false,
    localRecording: false,
    error: "",
    notice: "",
    partialText: "",
    liveVersion: 0,
    durationUpdatedAt: Date.now(),
  }
  private listeners = new Set<() => void>()
  private socket: WebSocket | null = null
  private recorder: PcmRecorder | null = null
  private nextSegment = 0
  private operation = Promise.resolve()
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectAttempts = 0
  private pending: {
    action: Action
    resolve: () => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  } | null = null

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot

  private update(values: Partial<Snapshot> = {}) {
    this.snapshot = {
      ...this.snapshot,
      ...values,
      localRecording: !!this.recorder && this.socket?.readyState === WebSocket.OPEN,
    }
    this.listeners.forEach((listener) => listener())
  }

  private setMeeting(meeting: Meeting, preservePartial = false) {
    const notice = {
      created: "等待录音",
      recording: "正在聆听，实时转写中",
      paused: "录音已暂停，内容已保存",
      ended: meeting.text ? "全部内容已保存" : "本次会议未检测到语音",
    }[meeting.status]
    const previous = this.snapshot.meeting
    this.update({ meeting: { ...meeting, minutes_version: (previous?.minutes_version ?? 0) + 1 }, notice,
      partialText: preservePartial && previous?.next_segment_id === meeting.next_segment_id ? this.snapshot.partialText : "",
      durationUpdatedAt: Date.now() })
    this.nextSegment = meeting.next_segment_id ?? 0
  }

  private applyTranscript(message: ServerMessage) {
    const meeting = this.snapshot.meeting
    if (!meeting || !message.revision || message.revision <= meeting.transcript_revision) return
    if (message.revision !== meeting.transcript_revision + 1) {
      void api<Meeting>(`/api/meetings/${meeting.id}`).then((record) => {
        if (this.snapshot.meeting?.id === record.id && record.transcript_revision >= this.snapshot.meeting.transcript_revision)
          this.setMeeting(record, true)
      }).catch((error) => this.update({ error: errorMessage(error) }))
      return
    }
    const removed = new Set(message.remove_segment_ids || [])
    const segments = new Map((meeting.segments || []).filter((s) => !removed.has(s.segment_id)).map((s) => [s.segment_id, s]))
    for (const segment of message.upsert_segments || []) segments.set(segment.segment_id, segment)
    const ordered = [...segments.values()].sort((a, b) => a.start_ms - b.start_ms || a.segment_id - b.segment_id)
    this.nextSegment = Math.max(this.nextSegment, message.next_segment_id ?? 0)
    this.update({ meeting: { ...meeting, segments: ordered,
      text: ordered.map((s) => s.text).filter(Boolean).join("\n\n"),
      speakers: { ...meeting.speakers, ...message.speakers },
      processing: message.processing || meeting.processing,
      next_segment_id: this.nextSegment, transcript_revision: message.revision,
      content_revision: (message.upsert_segments?.length || message.remove_segment_ids?.length || Object.keys(message.speakers || {}).length)
        ? message.revision : meeting.content_revision,
    } })
  }

  enter(meeting: Meeting) {
    this.reconnectAttempts = 0
    this.update({ error: "", finishing: false, liveVersion: 0 })
    this.setMeeting(meeting)
    if (meeting.status === "ended") void this.openSocket(meeting.id).catch((error) => this.update({ error: errorMessage(error) }))
  }

  dismissError = () => this.update({ error: "" })
  async retryDiarization() {
    const id = this.snapshot.meeting?.id
    if (!id || this.snapshot.busy) return
    this.update({ busy: true, error: "" })
    try {
      const meeting = await api<Meeting>(`/api/meetings/${id}/diarization`, { method: "POST" })
      if (this.snapshot.meeting?.id === id && meeting.transcript_revision >= this.snapshot.meeting.transcript_revision)
        this.setMeeting(meeting)
    } catch (error) {
      this.update({ error: errorMessage(error) })
    } finally {
      this.update({ busy: false })
    }
  }
  shouldWarnBeforeLeave = () => this.recorder?.state === "recording" || this.snapshot.finishing

  private disposeRecorder() {
    this.recorder?.close()
    this.recorder = null
  }

  private rejectCommand(error: Error) {
    if (!this.pending) return
    clearTimeout(this.pending.timeout)
    this.pending.reject(error)
    this.pending = null
  }

  disconnect() {
    clearTimeout(this.reconnectTimer)
    this.disposeRecorder()
    this.rejectCommand(new Error("会议连接已关闭"))
    const socket = this.socket
    this.socket = null
    socket?.close()
    const id = this.snapshot.meeting?.id
    if (id && this.snapshot.meeting?.status !== "ended") void this.refresh(id).catch(() => {})
    this.update({ partialText: "", finishing: false })
  }

  async leave() {
    await this.operation
    if (this.recorder?.state === "recording") await this.run("pause")
    this.disconnect()
    this.update({ meeting: null, finishing: false, error: "" })
  }

  private async refresh(id: string) {
    let record: Meeting | undefined
    for (let attempt = 0; attempt < 40; attempt++) {
      record = await api<Meeting>(`/api/meetings/${id}`)
      if (record.status !== "recording") break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (record && this.snapshot.meeting?.id === id) this.setMeeting(record)
  }

  private openSocket(id: string) {
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/meetings/${encodeURIComponent(id)}`,
    )
    this.socket = socket
    this.nextSegment = 0
    return new Promise<void>((resolve, reject) => {
      let ready = false
      const timeout = setTimeout(() => {
        reject(new Error("连接超时，请重试"))
        socket.close()
      }, 10000)
      socket.onmessage = ({ data }) => {
        if (this.socket !== socket) return
        const message: ServerMessage = JSON.parse(data)
        if (message.meeting_id !== id || this.snapshot.meeting?.id !== id) return
        if (message.type === "deleted") {
          this.disconnect()
          this.update({ error: "会议记录已删除，请返回会议列表。" })
        } else if (message.type === "ready" && message.meeting) {
          ready = true
          clearTimeout(timeout)
          this.setMeeting(message.meeting)
          resolve()
        } else if (message.type === "snapshot" && message.meeting) {
          this.setMeeting(message.meeting, true)
        } else if (message.type === "minutes" && this.snapshot.meeting) {
          this.update({ meeting: { ...this.snapshot.meeting, minutes_version: (this.snapshot.meeting.minutes_version ?? 0) + 1 } })
        } else if (message.type === "state" && message.meeting) {
          if (message.action === "end") this.update({ finishing: false })
          this.setMeeting(message.meeting)
          if (this.pending?.action === message.action && this.pending) {
            clearTimeout(this.pending.timeout)
            this.pending.resolve()
            this.pending = null
          }
        } else if (message.type === "transcript.update" || message.type === "processing") {
          this.applyTranscript(message)
        } else if ((message.type === "partial" || message.type === "final") && this.snapshot.meeting) {
          if (message.segment_id !== this.nextSegment) return
          if (message.type === "partial") {
            this.update({ partialText: message.text || "", notice: "正在识别当前发言…", liveVersion: this.snapshot.liveVersion + 1 })
          } else {
            this.applyTranscript(message)
            this.update({
              partialText: "",
              notice: message.text ? "转写内容已自动保存" : "等待语音",
              liveVersion: this.snapshot.liveVersion + 1,
            })
          }
        } else if (message.type === "error") {
          if (message.meeting) this.setMeeting(message.meeting)
          this.update({ error: message.message || "会议服务暂时不可用" })
          if (!ready) {
            clearTimeout(timeout)
            reject(new Error(message.message))
          }
          if (message.fatal) this.disposeRecorder()
          if (message.fatal || this.pending?.action === message.action)
            this.rejectCommand(new Error(message.message))
        }
      }
      socket.onerror = () => {
        if (this.socket === socket) this.update({ error: "无法连接会议服务，请检查网络后重试。" })
      }
      socket.onclose = () => {
        clearTimeout(timeout)
        if (!ready) reject(new Error("会议连接未建立"))
        if (this.socket !== socket) return
        this.socket = null
        this.disposeRecorder()
        this.rejectCommand(new Error("会议连接已断开，已识别的内容已保存"))
        if (this.snapshot.meeting?.status !== "ended") {
          this.update({
            finishing: false,
            partialText: "",
            error: this.snapshot.error || "连接已断开，已定稿内容已保存。可以重新进入会议继续录音。",
          })
          this.refresh(id).catch((error) => this.update({ error: errorMessage(error) }))
        } else if (this.reconnectAttempts < 5) {
          const delay = 1000 * 2 ** this.reconnectAttempts++
          this.reconnectTimer = setTimeout(() => {
            if (this.snapshot.meeting?.id === id && !this.socket)
              void this.openSocket(id).catch(() => {})
          }, delay)
        } else {
          this.update({ error: "后台状态连接已断开，请重新进入会议查看最新结果。" })
        }
        this.update()
      }
    })
  }

  private send(action: Action, extra: Record<string, string | number> = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("会议连接已断开"))
    return new Promise<void>((resolve, reject) => {
      this.pending = {
        action,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.rejectCommand(new Error("处理超时，请重新进入会议后重试"))
          this.socket?.close()
        }, 150000),
      }
      this.socket!.send(JSON.stringify({ type: action, ...extra }))
    })
  }

  private async start() {
    const id = this.snapshot.meeting!.id
    try {
      this.recorder = await PcmRecorder.create(
        (bytes) => {
          const socket = this.socket
          if (socket?.readyState !== WebSocket.OPEN) return
          // Stop explicitly instead of silently dropping microphone samples.
          if (socket.bufferedAmount + bytes.byteLength > this.recorder!.sampleRate * 2 * 3) {
            this.update({ error: "音频发送积压，录音已停止。请检查网络后继续会议。" })
            this.disconnect()
            return
          }
          socket.send(bytes)
        },
        (error) => { this.update({ error: error.message }); this.disconnect() },
      )
      await this.openSocket(id)
      await this.send(this.snapshot.meeting!.status === "created" ? "start" : "resume", {
        format: "pcm_s16le", sample_rate: this.recorder.sampleRate,
      })
      await this.recorder.resume()
      this.update({ finishing: false })
    } catch (error) {
      this.disconnect()
      await this.refresh(id).catch(() => {})
      throw error
    }
  }

  private async pause() {
    if (this.recorder?.state !== "recording") throw new Error("当前页面没有正在进行的录音")
    await this.recorder.pause()
    await this.send("pause")
  }

  private async resume() {
    if (!this.recorder || this.recorder.state === "inactive") return this.start()
    await this.send("resume", { format: "pcm_s16le", sample_rate: this.recorder.sampleRate })
    await this.recorder.resume()
  }

  private async end() {
    if (this.recorder) {
      this.update({ finishing: true })
      if (this.recorder.state === "recording") await this.recorder.pause()
      this.disposeRecorder()
    }
    if (this.socket?.readyState === WebSocket.OPEN) await this.send("end")
    else {
      const meeting = await api<Meeting>(`/api/meetings/${this.snapshot.meeting!.id}/end`, { method: "POST" })
      this.setMeeting(meeting)
      await this.openSocket(meeting.id)
    }
    this.update({ finishing: false })
  }

  run(action: Action) {
    if (this.snapshot.busy) return this.operation
    this.update({ busy: true, error: "" })
    this.operation = (async () => {
      try {
        await {
          start: () => this.start(),
          pause: () => this.pause(),
          resume: () => this.resume(),
          end: () => this.end(),
        }[action]()
      } catch (error) {
        this.update({ error: errorMessage(error) })
      } finally {
        this.update({ busy: false })
      }
    })()
    return this.operation
  }
}
