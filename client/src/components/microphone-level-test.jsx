import { useCallback, useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";

const INITIAL_STATE = {
  tone: "idle",
  text: "展开后将监听麦克风输入，不会上传或保存音频。",
};

export function MicrophoneLevelTest() {
  const [level, setLevel] = useState(0);
  const [state, setState] = useState(INITIAL_STATE);
  const runRef = useRef(0);
  const resourcesRef = useRef(null);

  const release = useCallback(() => {
    const resources = resourcesRef.current;
    resourcesRef.current = null;
    if (!resources) return;
    if (resources.frame) cancelAnimationFrame(resources.frame);
    resources.source?.disconnect();
    resources.stream.getTracks().forEach((track) => track.stop());
    void resources.context.close().catch(() => {});
  }, []);

  const stop = useCallback(() => {
    runRef.current += 1;
    release();
    setLevel(0);
    setState(INITIAL_STATE);
  }, [release]);

  const start = useCallback(async () => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !AudioContextClass) {
      setState({ tone: "error", text: "当前环境无法读取麦克风输入。" });
      return;
    }

    release();
    const run = ++runRef.current;
    setLevel(0);
    setState({ tone: "loading", text: "正在请求麦克风权限…" });
    let stream;
    let context;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 },
      });
      if (run !== runRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      context = new AudioContextClass();
      const resources = { context, stream, source: null, frame: 0 };
      resourcesRef.current = resources;
      await context.resume();
      if (run !== runRef.current) return;
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      resources.source = source;
      const samples = new Uint8Array(analyser.fftSize);
      setState({ tone: "listening", text: "正在监听，请对着麦克风说话。" });

      const update = () => {
        if (run !== runRef.current) return;
        analyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) {
          const amplitude = (sample - 128) / 128;
          energy += amplitude * amplitude;
        }
        const rms = Math.sqrt(energy / samples.length);
        setLevel(Math.min(100, Math.round(rms * 250)));
        resources.frame = requestAnimationFrame(update);
      };
      update();
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => {});
      if (run === runRef.current) {
        resourcesRef.current = null;
        setState({
          tone: "error",
          text: `无法监听麦克风：${error.message || "请检查系统权限"}`,
        });
      }
    }
  }, [release]);

  useEffect(
    () => () => {
      runRef.current += 1;
      release();
    },
    [release],
  );

  function handleToggle(event) {
    if (event.currentTarget.open) void start();
    else stop();
  }

  return (
    <details className="media-diagnostics" onToggle={handleToggle}>
      <summary>
        <Mic size={14} />
        麦克风输入测试
      </summary>
      <div className="microphone-level-test">
        <div
          className="microphone-level-meter"
          role="meter"
          aria-label="麦克风输入音量"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={level}
          aria-valuetext={`${level}%`}
        >
          <i style={{ width: `${level}%` }} />
        </div>
        <span>{level}%</span>
      </div>
      <small
        className={state.tone}
        role={state.tone === "error" ? "alert" : "status"}
      >
        {state.text}
      </small>
    </details>
  );
}
