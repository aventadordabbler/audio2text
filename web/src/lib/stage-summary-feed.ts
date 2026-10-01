import type { StageSummary, StageSummaryStatus } from "./stage-summary"

interface StageSummaryPayload {
  type?: string
  meeting_id?: string
  summaries?: StageSummary[]
  summary?: StageSummary
  window_seconds?: number
  message?: string
}

interface StageSummaryStatusUpdate {
  status: StageSummaryStatus
  error?: string
  windowSeconds?: number
}

export class StageSummaryFeed {
  private generation = 0
  private socket: WebSocket | null = null
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private connectTimer?: ReturnType<typeof setTimeout>
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private attempts = 0
  private lastPongAt = 0
  private meetingId = ""
  private rows: StageSummary[] = []
  private onSummaries?: (summaries: StageSummary[]) => void
  private onStatus?: (update: StageSummaryStatusUpdate) => void

  connect(meetingId: string, handlers: {
    onSummaries: (summaries: StageSummary[]) => void
    onStatus: (update: StageSummaryStatusUpdate) => void
  }) {
    this.disconnect()
    this.generation += 1
    this.meetingId = meetingId
    this.onSummaries = handlers.onSummaries
    this.onStatus = handlers.onStatus
    this.rows = []
    this.attempts = 0
    this.open(this.generation)
  }

  disconnect() {
    this.generation += 1
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.connectTimer)
    clearInterval(this.heartbeatTimer)
    this.reconnectTimer = undefined
    this.connectTimer = undefined
    this.heartbeatTimer = undefined
    const socket = this.socket
    this.socket = null
    socket?.close()
  }

  private open(generation: number) {
    if (generation !== this.generation) return
    this.onStatus?.({ status: this.attempts ? "reconnecting" : "connecting" })
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/meetings/${encodeURIComponent(this.meetingId)}/stage-summaries`,
    )
    this.socket = socket
    let ready = false
    let terminal = false
    let closeReason = ""
    this.connectTimer = setTimeout(() => {
      if (generation !== this.generation || this.socket !== socket || ready) return
      closeReason = "阶段总结连接超时，正在重连…"
      socket.close()
    }, 10000)

    socket.onmessage = ({ data }) => {
      if (generation !== this.generation || this.socket !== socket) return
      let payload: StageSummaryPayload
      try {
        payload = JSON.parse(data) as StageSummaryPayload
      } catch {
        terminal = true
        closeReason = "阶段总结服务返回了无效消息"
        this.onStatus?.({ status: "error", error: closeReason })
        socket.close()
        return
      }
      if (!payload || payload.meeting_id !== this.meetingId) return
      if (payload.type === "stage_summaries.snapshot") {
        ready = true
        clearTimeout(this.connectTimer)
        this.connectTimer = undefined
        this.attempts = 0
        this.rows = [...(payload.summaries || [])].sort((left, right) => left.start_seconds - right.start_seconds)
        this.onSummaries?.(this.rows)
        this.onStatus?.({ status: "live", windowSeconds: payload.window_seconds })
        this.startHeartbeat(socket, generation, () => { closeReason = "阶段总结心跳超时，正在重连…" })
      } else if (payload.type === "stage_summary.update" && payload.summary) {
        const index = this.rows.findIndex((row) => row.start_seconds === payload.summary!.start_seconds && row.end_seconds === payload.summary!.end_seconds)
        this.rows = index < 0
          ? [...this.rows, payload.summary]
          : this.rows.map((row, rowIndex) => rowIndex === index ? payload.summary! : row)
        this.rows.sort((left, right) => left.start_seconds - right.start_seconds)
        this.onSummaries?.([...this.rows])
      } else if (payload.type === "pong") {
        this.lastPongAt = Date.now()
      } else if (payload.type === "error") {
        terminal = true
        closeReason = payload.message || "阶段总结连接失败"
        this.onStatus?.({ status: "error", error: closeReason })
        socket.close()
      } else if (payload.type === "deleted") {
        terminal = true
        closeReason = "会议已删除"
        this.rows = []
        this.onSummaries?.([])
        this.onStatus?.({ status: "deleted", error: closeReason })
        socket.close()
      }
    }
    socket.onerror = () => {
      closeReason ||= "阶段总结连接失败，正在重连…"
      socket.close()
    }
    socket.onclose = (event) => {
      if (generation !== this.generation || this.socket !== socket) return
      clearTimeout(this.connectTimer)
      clearInterval(this.heartbeatTimer)
      this.connectTimer = undefined
      this.heartbeatTimer = undefined
      this.socket = null
      if (terminal || event.code === 1008) {
        if (!terminal) this.onStatus?.({ status: "error", error: closeReason || event.reason || "阶段总结连接被拒绝" })
        return
      }
      this.attempts += 1
      this.onStatus?.({ status: "reconnecting", error: closeReason || (ready ? "阶段总结连接已断开，正在重连…" : "正在连接阶段总结服务…") })
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempts - 1, 5))
      this.reconnectTimer = setTimeout(() => this.open(generation), delay)
    }
  }

  private startHeartbeat(socket: WebSocket, generation: number, onTimeout: () => void) {
    clearInterval(this.heartbeatTimer)
    this.lastPongAt = Date.now()
    const beat = () => {
      if (generation !== this.generation || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastPongAt > 45000) {
        onTimeout()
        socket.close()
        return
      }
      try {
        socket.send(JSON.stringify({ type: "ping" }))
      } catch {
        socket.close()
      }
    }
    beat()
    this.heartbeatTimer = setInterval(beat, 15000)
  }
}
