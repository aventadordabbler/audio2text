import { api, errorMessage, type Meeting } from "./meetings"

type Action = "start" | "pause" | "resume" | "end"
interface Snapshot {
  meeting: Meeting | null
  busy: boolean
  finishing: boolean
  localRecording: boolean
  error: string
  notice: string
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
    liveVersion: 0,
    durationUpdatedAt: Date.now(),
  }
  private listeners = new Set<() => void>()
  private socket: WebSocket | null = null
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private audioQueue = Promise.resolve()
  private uploadError: Error | null = null
  private operation = Promise.resolve()
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

  private setMeeting(meeting: Meeting) {
    const notice = {
      created: "等待录音",
      recording: "正在聆听，实时转写中",
      paused: "录音已暂停，内容已保存",
      ended: meeting.text ? "全部内容已保存" : "本次会议未检测到语音",
    }[meeting.status]
    this.update({ meeting, notice, durationUpdatedAt: Date.now() })
  }

  enter(meeting: Meeting) {
    this.update({ error: "", finishing: false, liveVersion: 0 })
    this.setMeeting(meeting)
  }

  dismissError = () => this.update({ error: "" })
  shouldWarnBeforeLeave = () => this.recorder?.state === "recording" || this.snapshot.finishing

  private stopTracks() {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
  }

  private disposeRecorder() {
    if (this.recorder) {
      this.recorder.ondataavailable = null
      if (this.recorder.state !== "inactive") this.recorder.stop()
      this.recorder = null
    }
    this.stopTracks()
  }

  private rejectCommand(error: Error) {
    if (!this.pending) return
    clearTimeout(this.pending.timeout)
    this.pending.reject(error)
    this.pending = null
  }

  disconnect() {
    this.disposeRecorder()
    this.rejectCommand(new Error("会议连接已关闭"))
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.update()
  }

  async leave() {
    await this.operation
    if (this.recorder?.state === "recording") await this.run("pause")
    this.disconnect()
    this.update({ meeting: null, finishing: false, error: "" })
  }

  private async refresh(id: string) {
    let record: Meeting | undefined
    for (let attempt = 0; attempt < 8; attempt++) {
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
        if (message.type === "ready" && message.meeting) {
          ready = true
          clearTimeout(timeout)
          this.setMeeting(message.meeting)
          resolve()
        } else if (message.type === "state" && message.meeting) {
          if (message.action === "end") this.update({ finishing: false })
          this.setMeeting(message.meeting)
          if (this.pending?.action === message.action && this.pending) {
            clearTimeout(this.pending.timeout)
            this.pending.resolve()
            this.pending = null
          }
        } else if (message.type === "transcript" && this.snapshot.meeting) {
          this.update({
            meeting: { ...this.snapshot.meeting, text: message.text || "" },
            notice: "转写内容已自动保存",
            liveVersion: this.snapshot.liveVersion + 1,
          })
        } else if (message.type === "no_speech") {
          this.update({ notice: "等待语音，请靠近麦克风说话" })
        } else if (message.type === "error") {
          if (message.meeting) this.setMeeting(message.meeting)
          this.update({ error: message.message || "会议服务暂时不可用" })
          if (!ready) {
            clearTimeout(timeout)
            reject(new Error(message.message))
          }
          if (this.pending?.action === message.action)
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
            error: "连接已断开，已识别内容已保存。可以重新进入会议继续录音。",
          })
          this.refresh(id).catch((error) => this.update({ error: errorMessage(error) }))
        }
        this.update()
      }
    })
  }

  private send(action: Action, extra: Record<string, string> = {}) {
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

  private event(name: string, trigger: () => void) {
    return new Promise<void>((resolve) => {
      this.recorder!.addEventListener(name, () => resolve(), { once: true })
      trigger()
    })
  }

  private async start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
      throw new Error("当前环境无法录音，请使用支持录音的浏览器，并通过 HTTPS 或 localhost 访问。")
    const id = this.snapshot.meeting!.id
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((value) =>
        MediaRecorder.isTypeSupported(value),
      )
      this.recorder = mimeType
        ? new MediaRecorder(this.stream, { mimeType })
        : new MediaRecorder(this.stream)
      await this.openSocket(id)
      await this.send(this.snapshot.meeting!.status === "created" ? "start" : "resume", {
        mime_type: this.recorder.mimeType,
      })
      const socket = this.socket!
      this.audioQueue = Promise.resolve()
      this.uploadError = null
      this.recorder.ondataavailable = ({ data }) => {
        if (!data.size) return
        this.audioQueue = this.audioQueue
          .then(async () => {
            const buffer = await data.arrayBuffer()
            if (socket.readyState !== WebSocket.OPEN) throw new Error("音频未发送，会议连接已断开")
            socket.send(buffer)
          })
          .catch((error) => {
            this.uploadError = error
            this.update({ error: errorMessage(error) })
            socket.close()
          })
      }
      this.recorder.onerror = () => {
        this.update({ error: "录音发生错误，请重新进入会议后继续。" })
        socket.close()
      }
      this.recorder.start(1000)
      this.update({ finishing: false })
    } catch (error) {
      this.disconnect()
      await this.refresh(id).catch(() => {})
      throw error
    }
  }

  private async pause() {
    if (this.recorder?.state !== "recording") throw new Error("当前页面没有正在进行的录音")
    await this.event("pause", () => this.recorder!.pause())
    this.stream!.getAudioTracks().forEach((track) => {
      track.enabled = false
    })
    await this.event("dataavailable", () => this.recorder!.requestData())
    await this.audioQueue
    if (this.uploadError) throw this.uploadError
    await this.send("pause")
  }

  private async resume() {
    if (!this.recorder || this.recorder.state === "inactive") return this.start()
    await this.send("resume")
    this.stream!.getAudioTracks().forEach((track) => {
      track.enabled = true
    })
    this.recorder.resume()
  }

  private async end() {
    if (this.recorder) {
      this.update({ finishing: true })
      if (this.recorder.state === "paused") this.recorder.ondataavailable = null
      if (this.recorder.state !== "inactive") await this.event("stop", () => this.recorder!.stop())
      this.recorder = null
      this.stopTracks()
      await this.audioQueue
      if (this.uploadError) throw this.uploadError
    }
    if (this.socket?.readyState === WebSocket.OPEN) await this.send("end")
    else
      this.setMeeting(
        await api<Meeting>(`/api/meetings/${this.snapshot.meeting!.id}/end`, { method: "POST" }),
      )
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
