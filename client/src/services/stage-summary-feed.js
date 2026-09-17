export class StageSummaryFeed {
  constructor() {
    this.generation = 0;
    this.socket = null;
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.heartbeatTimer = null;
    this.rows = [];
    this.attempts = 0;
    this.lastPongAt = 0;
  }

  connect(api, meetingId, { onSummaries, onStatus }) {
    this.disconnect();
    const generation = this.generation;
    this.api = api;
    this.meetingId = meetingId;
    this.onSummaries = onSummaries;
    this.onStatus = onStatus;
    this.rows = [];
    this.attempts = 0;
    this._open(generation);
  }

  disconnect() {
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.connectTimer);
    clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.heartbeatTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  _open(generation) {
    if (generation !== this.generation) return;
    this.onStatus?.({ status: this.attempts ? "reconnecting" : "connecting" });
    const socket = new WebSocket(this.api.stageSummarySocketUrl(this.meetingId));
    this.socket = socket;
    let ready = false;
    let terminal = false;
    let closeReason = "";
    this.connectTimer = setTimeout(() => {
      if (generation !== this.generation || this.socket !== socket || ready) return;
      closeReason = "阶段总结连接超时，正在重连…";
      socket.close();
    }, 10000);

    socket.onmessage = ({ data }) => {
      if (generation !== this.generation || this.socket !== socket) return;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        terminal = true;
        closeReason = "阶段总结服务返回了无效消息";
        this.onStatus?.({ status: "error", error: closeReason });
        socket.close();
        return;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        terminal = true;
        closeReason = "阶段总结服务返回了无效消息";
        this.onStatus?.({ status: "error", error: closeReason });
        socket.close();
        return;
      }
      if (payload.meeting_id !== this.meetingId) return;
      if (payload.type === "stage_summaries.snapshot") {
        ready = true;
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.attempts = 0;
        this.rows = [...(payload.summaries || [])].sort(
          (left, right) => left.start_seconds - right.start_seconds,
        );
        this.onSummaries?.(this.rows);
        this.onStatus?.({
          status: "live",
          windowSeconds: payload.window_seconds,
        });
        this._startHeartbeat(socket, generation, () => {
          closeReason = "阶段总结心跳超时，正在重连…";
        });
      } else if (payload.type === "stage_summary.update" && payload.summary) {
        const summary = payload.summary;
        const index = this.rows.findIndex(
          (row) =>
            row.start_seconds === summary.start_seconds &&
            row.end_seconds === summary.end_seconds,
        );
        this.rows =
          index < 0
            ? [...this.rows, summary]
            : this.rows.map((row, rowIndex) =>
                rowIndex === index ? summary : row,
              );
        this.rows.sort((left, right) => left.start_seconds - right.start_seconds);
        this.onSummaries?.([...this.rows]);
      } else if (payload.type === "pong") {
        this.lastPongAt = Date.now();
      } else if (payload.type === "error") {
        terminal = true;
        closeReason = payload.message || "阶段总结连接失败";
        this.onStatus?.({
          status: "error",
          error: closeReason,
        });
        socket.close();
      } else if (payload.type === "deleted") {
        terminal = true;
        closeReason = "会议已删除";
        this.rows = [];
        this.onSummaries?.([]);
        this.onStatus?.({ status: "deleted", error: closeReason });
        socket.close();
      }
    };
    socket.onerror = () => {
      closeReason ||= "阶段总结连接失败，正在重连…";
      socket.close();
    };
    socket.onclose = (event) => {
      if (generation !== this.generation || this.socket !== socket) return;
      clearTimeout(this.connectTimer);
      clearInterval(this.heartbeatTimer);
      this.connectTimer = null;
      this.heartbeatTimer = null;
      this.socket = null;
      if (terminal || event.code === 1008) {
        if (!terminal) {
          this.onStatus?.({
            status: "error",
            error: closeReason || event.reason || "阶段总结连接被拒绝",
          });
        }
        return;
      }
      this.attempts += 1;
      this.onStatus?.({
        status: "reconnecting",
        error:
          closeReason ||
          (ready ? "阶段总结连接已断开，正在重连…" : "正在连接阶段总结服务…"),
      });
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempts - 1, 5));
      this.reconnectTimer = setTimeout(() => this._open(generation), delay);
    };
  }

  _startHeartbeat(socket, generation, onTimeout) {
    clearInterval(this.heartbeatTimer);
    this.lastPongAt = Date.now();
    const beat = () => {
      if (
        generation !== this.generation ||
        this.socket !== socket ||
        socket.readyState !== WebSocket.OPEN
      )
        return;
      if (Date.now() - this.lastPongAt > 45000) {
        onTimeout();
        socket.close();
        return;
      }
      try {
        socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        socket.close();
      }
    };
    beat();
    this.heartbeatTimer = setInterval(beat, 15000);
  }
}
