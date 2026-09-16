export class PcmRecorder {
  state: "paused" | "recording" | "inactive" = "paused"
  private sequence = 0
  private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  private constructor(
    private context: AudioContext,
    private stream: MediaStream,
    private source: MediaStreamAudioSourceNode,
    private node: AudioWorkletNode,
    onAudio: (bytes: ArrayBuffer) => void,
    onError: (error: Error) => void,
  ) {
    node.port.onmessage = ({ data }) => {
      if (data.type === "audio") onAudio(data.bytes)
      else if (data.type === "ack") {
        const operation = this.pending.get(data.id)
        if (operation) {
          clearTimeout(operation.timer)
          this.pending.delete(data.id)
          operation.resolve()
        }
      }
    }
    node.onprocessorerror = () => onError(new Error("音频采集失败，请重新进入会议继续。"))
    for (const track of stream.getTracks()) {
      track.onended = () => onError(new Error("麦克风已断开，请重新连接后继续会议。"))
    }
  }

  get sampleRate() { return this.context.sampleRate }

  static async create(onAudio: (bytes: ArrayBuffer) => void, onError: (error: Error) => void) {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined")
      throw new Error("当前环境无法录音，请使用支持 AudioWorklet 的浏览器，并通过 HTTPS 或 localhost 访问。")
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
    let context: AudioContext | undefined
    try {
      try { context = new AudioContext({ sampleRate: 16000 }) }
      catch { context = new AudioContext() }
      await context.audioWorklet.addModule("/pcm-worklet.js")
      const source = context.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(context, "meeting-pcm")
      source.connect(node)
      node.connect(context.destination) // Processor outputs silence; never plays the microphone.
      return new PcmRecorder(context, stream, source, node, onAudio, onError)
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop())
      await context?.close()
      throw error
    }
  }

  private command(type: "pause" | "resume") {
    const id = ++this.sequence
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error("麦克风响应超时，请重新进入会议。"))
      }, 5000)
      this.pending.set(id, { resolve, reject, timer })
      this.node.port.postMessage({ type, id })
    })
  }

  async resume() {
    await this.context.resume()
    this.stream.getAudioTracks().forEach((track) => { track.enabled = true })
    await this.command("resume")
    this.state = "recording"
  }

  async pause() {
    await this.command("pause") // Audio messages and the ack share one ordered MessagePort.
    this.stream.getAudioTracks().forEach((track) => { track.enabled = false })
    this.state = "paused"
  }

  close() {
    this.state = "inactive"
    this.node.port.onmessage = null
    this.node.onprocessorerror = null
    this.node.disconnect()
    this.source.disconnect()
    this.stream.getTracks().forEach((track) => { track.onended = null; track.stop() })
    void this.context.close().catch(() => {})
    for (const operation of this.pending.values()) {
      clearTimeout(operation.timer)
      operation.reject(new Error("麦克风已关闭"))
    }
    this.pending.clear()
  }
}
