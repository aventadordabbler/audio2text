import { MeetingApi } from "./meeting-api.js";
import { PcmRecorder } from "./pcm-recorder.js";
import { applyTranscriptEvent } from "./transcript.js";

export class MeetingRecorder {
  constructor({ createRecorder = PcmRecorder.create } = {}) {
    this.createRecorder = createRecorder;
    this.nextSegment = 0;
    this.backend = "electron-media";
    this.running = false;
    this.paused = false;
    this.socket = null;
    this.stream = null;
    this.mediaRecorder = null;
    this.api = null;
    this.meeting = null;
    this.pending = null;
    this.audioQueue = Promise.resolve();
    this.transcriptQueue = Promise.resolve();
    this.uploadError = null;
    this.chunkSeconds = 1;
    this.readOnly = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.minutesVersion = 0;
  }

  emitEvent(payload) {
    this.onEvent?.({ meeting_id: this.meeting?.id, baseUrl: this.api?.config.baseUrl, ...payload });
  }

  async health() {
    return {
      status: this.running ? "recording" : this.paused ? "paused" : "idle",
      paused: this.paused,
      backend: this.backend,
      last_error: "",
    };
  }

  probe(config) {
    return new MeetingApi(config).probe();
  }

  async configure(config) {
    this.api = new MeetingApi(config);
    return { ok: true, message: "录音配置已更新" };
  }

  isPaused() {
    return this.paused;
  }

  setMeeting(meeting, preservePartial = false, updateClock = true) {
    if (this.meeting?.id === meeting.id && meeting.transcript_revision < this.meeting.transcript_revision)
      return;
    if (!preservePartial || this.nextSegment !== meeting.next_segment_id)
      this.onPreview?.("");
    this.meeting = meeting;
    this.nextSegment = meeting.next_segment_id || 0;
    this.emitEvent({
      type: "meeting",
      meeting,
      baseUrl: this.api.config.baseUrl,
      updateClock,
    });
    if (typeof meeting.text === "string") this.receiveTranscript(meeting.text);
  }

  receiveTranscript(text) {
    if (this.meeting) this.meeting = { ...this.meeting, text };
    const payload = {
      type: "transcript",
      meeting_id: this.meeting?.id,
      text,
      cumulative: true,
      meeting: this.meeting,
      baseUrl: this.api.config.baseUrl,
    };
    this.transcriptQueue = this.transcriptQueue
      .then(() => this.onTranscript?.(text, payload))
      .catch((error) =>
        this.emitEvent({
          type: "error",
          text: `更新转写失败: ${error.message}`,
        }),
      );
  }

  async observe(meeting, onTranscript, onPreview, onEvent) {
    if (meeting.status !== "ended") throw new Error("仅已结束会议支持只读订阅");
    this.onTranscript = onTranscript;
    this.onPreview = onPreview;
    this.onEvent = onEvent;
    if (this.meeting?.id === meeting.id && this.socket?.readyState === WebSocket.OPEN)
      return;
    this.disconnect();
    this.reconnectAttempts = 0;
    this.setMeeting(meeting);
    await this.openSocket();
  }

  async syncMinutes() {
    const version = ++this.minutesVersion;
    const api = this.api, id = this.meeting?.id, socket = this.socket;
    try {
      const minutes = await api.minutes(id);
      if (version === this.minutesVersion && this.socket === socket && this.meeting?.id === id)
        this.emitEvent({ type: "minutes", minutes });
    } catch (error) {
      if (version === this.minutesVersion && this.socket === socket)
        this.emitEvent({ type: "minutes-error", text: `总结同步失败：${error.message}` });
    }
  }

  async retryDiarization() {
    const api = this.api, id = this.meeting?.id;
    const meeting = await api.retryDiarization(id);
    if (api === this.api && id === this.meeting?.id) this.setMeeting(meeting, true);
    return meeting;
  }

  async generateMinutes() {
    const version = ++this.minutesVersion;
    const api = this.api, id = this.meeting?.id;
    const minutes = await api.generateMinutes(id);
    if (version === this.minutesVersion && api === this.api && this.meeting?.id === id)
      this.emitEvent({ type: "minutes", minutes });
  }

  async applyEvent(payload, socket) {
    let updated = applyTranscriptEvent(this.meeting, payload);
    if (!updated) {
      // Messages are processed in order while this read is in flight.
      const meeting = await this.api.get(this.meeting.id);
      if (this.socket !== socket) return;
      this.setMeeting(meeting, true);
      updated = applyTranscriptEvent(this.meeting, payload);
      if (!updated) throw new Error("转写版本不同步，请重新连接会议");
    }
    if (this.socket === socket && updated !== this.meeting)
      this.setMeeting(updated, true, false);
  }

  async start(
    chunkSeconds,
    onTranscript,
    onPreview,
    onEvent,
    title = "未命名会议",
    { departmentId = null, meetingId = null } = {},
  ) {
    if (!this.api) throw new Error("转写服务地址未配置");
    this.disconnect();
    this.reconnectAttempts = 0;
    this.onTranscript = onTranscript;
    this.onPreview = onPreview;
    this.onEvent = onEvent;
    this.chunkSeconds = Math.min(1, Math.max(0.1, Number(chunkSeconds) || 1));
    this.meeting = null;
    this.transcriptQueue = Promise.resolve();
    try {
      await this.openMedia();
      this.setMeeting(
        meetingId
          ? await this.api.get(meetingId)
          : await this.api.create(title, departmentId),
      );
      await this.beginRecording();
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  async beginRecording() {
    await this.openSocket();
    await this.sendCommand(
      this.meeting.status === "created" ? "start" : "resume",
      {
        format: "pcm_s16le",
        sample_rate: this.mediaRecorder.sampleRate,
      },
    );
    await this.mediaRecorder.resume();
    this.running = true;
    this.paused = false;
    this.emitEvent({ type: "status", status: "recording", text: "录音已开始" });
  }

  async pause() {
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state !== "recording") return;
    await recorder.pause();
    this.running = false;
    this.paused = true;
    await this.flushAudio();
    await this.sendCommand("pause");
    this.emitEvent({
      type: "status",
      status: "paused",
      text: "录音已暂停，转写已保存",
    });
  }

  async resume() {
    if (!this.meeting || this.meeting.status === "ended") return;
    if (!this.mediaRecorder || this.socket?.readyState !== WebSocket.OPEN) {
      try {
        // A failed end may leave an open socket with an already stopped recorder.
        // Reconnect the PCM stream after the previous socket has released its meeting.
        if (this.socket) {
          const socket = this.socket;
          const closed =
            socket.readyState === WebSocket.CLOSED
              ? Promise.resolve()
              : new Promise((resolve) =>
                  socket.addEventListener("close", resolve, { once: true }),
                );
          this.disconnect();
          await closed;
        }
        this.setMeeting(await this.api.get(this.meeting.id));
        await this.openMedia();
        await this.beginRecording();
      } catch (error) {
        this.disconnect();
        throw error;
      }
      return;
    }
    await this.sendCommand("resume", {
      format: "pcm_s16le",
      sample_rate: this.mediaRecorder.sampleRate,
    });
    await this.mediaRecorder.resume();
    this.running = true;
    this.paused = false;
    this.emitEvent({ type: "status", status: "recording", text: "录音已恢复" });
  }

  async stop() {
    if (!this.meeting) return;
    this.running = false;
    this.paused = true;
    const recorder = this.mediaRecorder;
    if (recorder) {
      if (recorder.state === "recording") await recorder.pause();
      this.disposeMedia();
      await this.flushAudio();
    }
    if (this.meeting.status !== "ended") {
      if (this.socket?.readyState === WebSocket.OPEN)
        await this.sendCommand("end");
      else {
        this.setMeeting(await this.api.end(this.meeting.id));
        await this.openSocket();
      }
    }
    await this.transcriptQueue;
    this.paused = false;
    this.onPreview?.("");
    this.emitEvent({ type: "status", status: "idle", text: "录音已结束" });
    return this.meeting;
  }

  disposeMedia() {
    this.mediaRecorder?.close();
    this.mediaRecorder = null;
    this.stream = null;
  }

  disconnect() {
    clearTimeout(this.reconnectTimer);
    this.minutesVersion++;
    this.disposeMedia();
    this.running = false;
    this.paused = Boolean(this.meeting && this.meeting.status !== "ended");
    this.rejectCommand(new Error("会议连接已关闭"));
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  rejectCommand(error) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = null;
  }

  sendCommand(action, extra = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("会议连接已断开"));
    if (this.readOnly && action !== "ping")
      return Promise.reject(new Error("会议已结束，只能查看记录"));
    if (this.pending)
      return Promise.reject(new Error("请等待上一个会议操作完成"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectCommand(new Error("会议处理超时，请重试"));
        this.socket?.close();
      }, 150000);
      this.pending = { action, resolve, reject, timer };
      try {
        this.socket.send(JSON.stringify({ type: action, ...extra }));
      } catch (error) {
        this.rejectCommand(error);
      }
    });
  }

  openSocket() {
    clearTimeout(this.reconnectTimer);
    return new Promise((resolve, reject) => {
      const id = this.meeting.id;
      const socket = new WebSocket(this.api.socketUrl(id));
      this.socket = socket;
      let ready = false;
      let messages = Promise.resolve();
      const timer = setTimeout(() => {
        reject(new Error("连接会议服务超时"));
        socket.close();
      }, 10000);
      const handle = async ({ data }) => {
        if (this.socket !== socket) return;
        let payload;
        try {
          payload = JSON.parse(data);
          if (!payload || typeof payload !== "object") throw new Error();
        } catch {
          const error = new Error("会议服务返回了无效消息");
          clearTimeout(timer);
          reject(error);
          this.rejectCommand(error);
          socket.close();
          return;
        }
        if (payload.meeting_id !== id || this.meeting?.id !== id)
          return;
        if (payload.type === "ready" && payload.meeting) {
          ready = true;
          this.reconnectAttempts = 0;
          this.readOnly = Boolean(payload.read_only);
          clearTimeout(timer);
          this.setMeeting(payload.meeting);
          if (this.readOnly) void this.syncMinutes();
          resolve();
        } else if (payload.type === "snapshot" && payload.meeting) {
          this.setMeeting(payload.meeting, true);
          if (this.meeting.status === "ended") void this.syncMinutes();
        } else if (payload.type === "transcript.update" || payload.type === "processing" || payload.type === "final") {
          await this.applyEvent(payload, socket);
        } else if (payload.type === "minutes") {
          this.minutesVersion++;
          this.emitEvent(payload);
        } else if (payload.type === "deleted") {
          this.disconnect();
          this.emitEvent(payload);
        } else if (payload.type === "state" && payload.meeting) {
          this.setMeeting(payload.meeting);
          if (payload.action === "end") {
            this.readOnly = true;
            void this.syncMinutes();
          }
          if (this.pending?.action === payload.action) {
            const pending = this.pending;
            clearTimeout(pending.timer);
            this.pending = null;
            this.transcriptQueue.then(pending.resolve, pending.reject);
          }
        } else if (payload.type === "partial") {
          if (payload.segment_id !== this.nextSegment) return;
          this.onPreview?.(payload.text || "");
        } else if (payload.type === "no_speech") {
          this.emitEvent({
            type: "status",
            text: "暂未检测到语音，等待说话...",
          });
        } else if (payload.type === "flow") {
          this.emitEvent({
            type: "flow",
            level: payload.level,
            pending_seconds: payload.pending_seconds,
            text:
              payload.level === "lagging"
                ? `转写有延迟（积压约 ${payload.pending_seconds} 秒），正在追赶。`
                : "转写延迟已恢复。",
          });
        } else if (payload.type === "error") {
          const error = new Error(payload.message || "会议服务返回错误");
          if (payload.meeting) this.setMeeting(payload.meeting);
          if (!ready) {
            clearTimeout(timer);
            reject(error);
          }
          if (payload.fatal || this.pending?.action === payload.action)
            this.rejectCommand(error);
          if (payload.fatal) {
            this.disposeMedia();
            socket.close();
          }
          this.emitEvent({ type: "error", text: error.message });
        }
      };
      socket.onmessage = (message) => {
        messages = messages.then(() => handle(message)).catch((error) => {
          if (this.socket !== socket) return;
          clearTimeout(timer);
          if (!ready) reject(error);
          this.rejectCommand(error);
          this.emitEvent({ type: "error", text: error.message });
          socket.close();
        });
      };
      socket.onerror = () => {
        clearTimeout(timer);
        const error = new Error("无法连接会议服务");
        if (!ready) reject(error);
        this.rejectCommand(error);
        socket.close();
      };
      socket.onclose = () => {
        clearTimeout(timer);
        if (!ready) reject(new Error("会议连接未建立"));
        if (this.socket !== socket) return;
        this.socket = null;
        this.minutesVersion++;
        this.onPreview?.("");
        this.disposeMedia();
        this.running = false;
        this.paused = this.meeting?.status !== "ended";
        this.rejectCommand(new Error("会议连接已断开，已识别内容已保存"));
        if (this.paused)
          this.emitEvent({
            type: "disconnected",
            text: "连接已断开，已识别内容已保存。可点击继续重连，或结束会议。",
          });
        else if (this.reconnectAttempts < 5) {
          const delay = 1000 * 2 ** this.reconnectAttempts++;
          this.reconnectTimer = setTimeout(() => {
            if (this.meeting?.id === id && !this.socket)
              void this.openSocket().catch(() => {});
          }, delay);
        } else {
          this.emitEvent({ type: "error", text: "后台状态连接已断开，请重新进入会议查看最新结果。" });
        }
      };
    });
  }

  async flushAudio() {
    if (this.uploadError) throw this.uploadError;
  }

  async openMedia() {
    this.uploadError = null;
    this.mediaRecorder = await this.createRecorder(
      (buffer) => {
        const socket = this.socket;
        try {
          if (socket?.readyState !== WebSocket.OPEN)
            throw new Error("音频未发送，会议连接已断开");
          if (
            socket.bufferedAmount + buffer.byteLength >
            this.mediaRecorder.sampleRate * 2 * 3
          )
            throw new Error("音频发送积压，请检查网络后继续会议");
          socket.send(buffer);
        } catch (error) {
          this.uploadError = error;
          this.emitEvent({ type: "error", text: error.message });
          this.disconnect();
        }
      },
      (error) => {
        this.disconnect();
        this.emitEvent({ type: "disconnected", text: error.message });
      },
      this.chunkSeconds,
    );
    this.stream = this.mediaRecorder.stream;
  }
}
