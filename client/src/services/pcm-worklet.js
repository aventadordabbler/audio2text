// Capture only: the AudioContext resamples when supported; the model service handles fallback rates.
class MeetingPCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.active = false;
    this.size = Math.round(
      sampleRate *
        Math.min(
          1,
          Math.max(0.1, Number(options?.processorOptions?.chunkSeconds) || 1),
        ),
    ); // The server accepts at most one second per frame.
    this.reset();
    this.port.onmessage = ({ data }) => {
      if (data.type === "pause") {
        this.active = false;
        this.flush(); // Deliver even a single remaining sample before acknowledging the pause.
      } else if (data.type === "resume") {
        this.active = true;
      }
      this.port.postMessage({ type: "ack", id: data.id });
    };
  }
  reset() {
    this.buffer = new ArrayBuffer(this.size * 2);
    this.view = new DataView(this.buffer);
    this.count = 0;
  }
  flush() {
    if (!this.count) return;
    const bytes =
      this.count === this.size
        ? this.buffer
        : this.buffer.slice(0, this.count * 2);
    this.port.postMessage({ type: "audio", bytes }, [bytes]);
    this.reset();
  }
  process(inputs) {
    const channels = inputs[0];
    if (!this.active || !channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      this.view.setInt16(
        this.count * 2,
        Math.round(sample * (sample < 0 ? 32768 : 32767)),
        true,
      );
      if (++this.count === this.size) this.flush();
    }
    return true;
  }
}
registerProcessor("meeting-pcm", MeetingPCMProcessor);
