import { useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  ArrowLeft,
  Mic,
  Pause,
  Play,
  Square,
  Minus,
  Maximize2,
  X,
  Settings,
  FileText,
  LoaderCircle,
  AudioLines,
  CalendarDays,
  CheckCheck,
  ChevronRight,
  FolderClosed,
  Languages,
  MicOff,
  PanelLeft,
  RefreshCw,
  Save,
  Sparkles,
  ArrowUpRight,
  Download,
} from "lucide-react";
import {
  WorkspaceBrand,
  EmptyDocument,
  RecordingWave,
} from "@/components/workspace-ui.jsx";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import MinutesMarkdown from "@/components/minutes-markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DesktopStore } from "@/services/desktop-store.js";
import { MeetingRecorder } from "@/services/meeting-recorder.js";
import {
  DEFAULT_CONFIG,
  STT_LANGUAGE_OPTIONS,
  normalizeSttConfig,
} from "@/shared/defaults.js";

import { MeetingApi } from "@/services/meeting-api.js";
import {
  sessionFromMeeting,
  sessionWithMinutes,
  MEETING_STATUS_LABELS,
} from "@/services/meeting-catalog.js";
import {
  MeetingManagement,
  CreateMeetingDialog,
} from "@/components/meeting-management.jsx";
import { DepartmentManagement } from "@/components/department-management.jsx";
import {
  LLM_SETTINGS_FORM_ID,
  ServerModelSettings,
} from "@/components/server-model-settings.jsx";

const store = new DesktopStore();
const recorder = new MeetingRecorder();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compactText(text, max = 30) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > max
    ? `${normalized.slice(0, max)}...`
    : normalized;
}

function deriveSessionTitle(session) {
  if (session?.title) return session.title;
  const minutesSummary = String(session?.minutes || "");
  if (minutesSummary) {
    const firstLine = minutesSummary
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (firstLine) return compactText(firstLine, 22);
  }
  const firstTranscript = session?.transcript?.[0]?.text;
  if (firstTranscript) return compactText(firstTranscript, 22);
  return "未命名会议";
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function sectionTone(isRecording, paused, hasSession, remoteStatus) {
  if (!hasSession || !isRecording) {
    return {
      variant: "secondary",
      label: hasSession
        ? MEETING_STATUS_LABELS[remoteStatus] || "会议已结束"
        : "待命中",
    };
  }
  if (paused) return { variant: "secondary", label: "已暂停" };
  return {
    variant: "default",
    label: "实时录制中",
  };
}

function Field({ label, children }) {
  return (
    <Label className="form-field">
      <span>{label}</span>
      {children}
    </Label>
  );
}

export function App() {
  const [ready, setReady] = useState(false);
  const [platform, setPlatform] = useState("unknown");
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [formConfig, setFormConfig] = useState(DEFAULT_CONFIG);
  const [session, setSession] = useState(null);
  const [sessionSelection, setSessionSelection] = useState(0);
  const [sessions, setSessions] = useState([]);
  const [activeView, setActiveView] = useState("history");
  const [activeFocusTab, setActiveFocusTab] = useState("transcript");
  const [settingsTab, setSettingsTab] = useState("stt");
  const [llmSaveState, setLlmSaveState] = useState({
    canSave: false,
    busy: false,
  });
  const [departments, setDepartments] = useState([]);
  const [departmentsLoading, setDepartmentsLoading] = useState(false);
  const [departmentsError, setDepartmentsError] = useState("");
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const meetingApi = useMemo(() => {
    try {
      return new MeetingApi(config.stt);
    } catch {
      return null;
    }
  }, [config.stt.baseUrl, config.stt.language]);
  const [autoScroll, setAutoScroll] = useState(true);
  const transcriptScrollRef = useRef(null);
  const [statusLine, setStatusLine] = useState("待命");
  const [settingsSavedAtLabel, setSettingsSavedAtLabel] = useState("");
  const [isMaximized, setIsMaximized] = useState(false);
  const [providerProbe, setProviderProbe] = useState({
    stt: { tone: "", text: "尚未测试语音转写服务。" },
    llm: { tone: "", text: "尚未测试大语言模型服务。" },
  });
  const [mediaSupport, setMediaSupport] = useState({
    helperReady: true,
    message: "浏览器媒体链路待检测",
  });
  const [mediaProbeText, setMediaProbeText] = useState("");
  const [livePreview, setLivePreview] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isControlling, setIsControlling] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [diarizationReady, setDiarizationReady] = useState(null);
  const [retryingDiarization, setRetryingDiarization] = useState(false);
  const [exportingAudio, setExportingAudio] = useState(false);
  const [startedAtMs, setStartedAtMs] = useState(0);
  const [elapsedLabel, setElapsedLabel] = useState("00:00:00");
  const [reportTask, setReportTask] = useState({
    running: false,
    text: "",
  });

  const queueRef = useRef(Promise.resolve());
  const timerRef = useRef(null);
  const sessionRef = useRef(session);
  const startingRef = useRef(false);
  const sessionLoadRef = useRef(0);
  const controllingRef = useRef(false);
  const recordingClockRef = useRef({ seconds: 0, updatedAt: Date.now() });
  const recordingRef = useRef(isRecording);
  const configRef = useRef(config);
  const pendingTranscriptRef = useRef("");

  useEffect(() => {
    setDepartments([]);
    setDepartmentsError("");
    if (!ready || !meetingApi) {
      setDepartmentsLoading(false);
      return;
    }
    const controller = new AbortController();
    setDepartmentsLoading(true);
    meetingApi
      .departments({
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10000),
        ]),
      })
      .then((items) => {
        if (!controller.signal.aborted) setDepartments(items);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setDepartmentsError(`部门加载失败：${error.message}`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDepartmentsLoading(false);
      });
    return () => controller.abort();
  }, [
    ready,
    meetingApi,
    catalogRevision,
    createOpen,
    activeView === "departments",
  ]);

  function refreshCatalog() {
    setCatalogRevision((value) => value + 1);
  }

  useEffect(() => {
    if (
      !autoScroll ||
      !isRecording ||
      activeView !== "overview" ||
      activeFocusTab !== "transcript"
    )
      return;
    const viewport = transcriptScrollRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [
    session?.transcript,
    livePreview,
    autoScroll,
    isRecording,
    activeView,
    activeFocusTab,
  ]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    recordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe = () => {};

    window.meetingDesktop
      ?.getWindowState?.()
      .then((state) => {
        if (!disposed) {
          setIsMaximized(Boolean(state?.isMaximized));
        }
      })
      .catch(() => {});

    if (window.meetingDesktop?.onWindowStateChange) {
      unsubscribe = window.meetingDesktop.onWindowStateChange((state) => {
        setIsMaximized(Boolean(state?.isMaximized));
      });
    }

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    async function bootstrap() {
      const payload = await store.bootstrap();
      if (disposed) return;

      const nextConfig = {
        ...clone(DEFAULT_CONFIG),
        ...payload.config,
        stt: { ...clone(DEFAULT_CONFIG.stt), ...(payload.config?.stt || {}) },
        llm: { ...clone(DEFAULT_CONFIG.llm), ...(payload.config?.llm || {}) },
      };
      nextConfig.stt = normalizeSttConfig(nextConfig.stt);
      nextConfig.chunkSeconds = DEFAULT_CONFIG.chunkSeconds;

      if (!nextConfig.stt.baseUrl) {
        nextConfig.stt.baseUrl = DEFAULT_CONFIG.stt.baseUrl;
      }
      if (nextConfig.stt.baseUrl === "http://f.axe3.cn:22395") {
        nextConfig.stt.baseUrl = DEFAULT_CONFIG.stt.baseUrl;
        nextConfig.stt.protocol = "audio2text";
      }

      setPlatform(payload.platform || "unknown");
      setConfig(nextConfig);
      setFormConfig(nextConfig);
      setSessions([]);
      setStatusLine("准备就绪");
      refreshMediaProbe();
      await refreshBridgeState(nextConfig);
      setReady(true);
    }

    bootstrap();

    return () => {
      disposed = true;
      clearInterval(timerRef.current);
      recorder.disconnect();
    };
  }, []);

  function refreshMediaProbe() {
    const lines = [
      `backend: ${recorder.backend || "unknown"}`,
      `navigator: ${typeof navigator}`,
      `mediaDevices: ${typeof navigator?.mediaDevices}`,
      `getUserMedia: ${typeof navigator?.mediaDevices?.getUserMedia}`,
      `AudioContext: ${typeof window.AudioContext}`,
      `WebSocket: ${typeof window.WebSocket}`,
    ];
    setMediaProbeText(lines.join(" | "));
  }

  async function refreshBridgeState(nextConfig = configRef.current) {
    try {
      const health = await recorder.health();
      setMediaSupport({
        helperReady: true,
        message:
          health.status === "recording"
            ? "浏览器音频采集链路运行中"
            : "浏览器音频采集链路可用",
      });
    } catch {
      setMediaSupport({
        helperReady: false,
        message: "浏览器音频采集链路不可用",
      });
    }
  }

  function updateForm(path, value) {
    setFormConfig((current) => {
      const next = clone(current);
      const segments = path.split(".");
      let cursor = next;
      for (let index = 0; index < segments.length - 1; index += 1) {
        cursor = cursor[segments[index]];
      }
      cursor[segments[segments.length - 1]] = value;
      return next;
    });
    setSettingsSavedAtLabel("");
    setProviderProbe({
      stt: { tone: "", text: "配置已修改，请重新测试语音转写服务。" },
      llm: { tone: "", text: "配置已修改，请重新测试大语言模型服务。" },
    });
  }

  useEffect(() => {
    if (!ready) return;
    recorder.disconnect();
    sessionLoadRef.current++;
    setSessions([]);
    setSession(null);
    sessionRef.current = null;
    void reloadSessions();
  }, [ready, config.stt.baseUrl]);

  async function reloadSessions() {
    try {
      const client = new MeetingApi(configRef.current.stt);
      const meetings = await client.list(
        {},
        { signal: AbortSignal.timeout(10000) },
      );
      if (client.config.baseUrl !== configRef.current.stt.baseUrl)
        return;
      setSessions((previous) =>
        meetings.map((meeting) => {
          const data = sessionFromMeeting(
            meeting,
            client.config.baseUrl,
            previous.find((item) => item.id === meeting.id)?.data,
          );
          return { id: data.id, title: data.title, data };
        }),
      );
    } catch (error) {
      setStatusLine(`会议列表加载失败：${error.message}`);
    }
  }

  async function updateSession(nextSession, options = {}) {
    if (!nextSession) return;
    const snapshot = clone(nextSession);
    setSessions((previous) => {
      const entry = { id: snapshot.id, title: snapshot.title, data: snapshot };
      const found = previous.some((item) => item.id === snapshot.id);
      return found
        ? previous.map((item) => (item.id === snapshot.id ? entry : item))
        : [entry, ...previous];
    });
    if (options.syncView === false || sessionRef.current?.id !== snapshot.id)
      return;
    setSession(snapshot);
    sessionRef.current = snapshot;
  }

  async function saveConfig(nextConfigOverride) {
    const nextConfig = clone(nextConfigOverride || formConfig);
    nextConfig.stt = normalizeSttConfig(nextConfig.stt);
    nextConfig.chunkSeconds = DEFAULT_CONFIG.chunkSeconds;
    if (!nextConfig.stt.baseUrl) {
      nextConfig.stt.baseUrl = DEFAULT_CONFIG.stt.baseUrl;
    }
    if (
      recordingRef.current &&
      nextConfig.stt.baseUrl !== configRef.current.stt.baseUrl
    ) {
      setStatusLine("请先结束会议，再切换会议服务");
      return configRef.current;
    }
    nextConfig.meetingTitle = "";
    await store.saveConfig(nextConfig);
    setConfig(nextConfig);
    setFormConfig(nextConfig);
    configRef.current = nextConfig;
    setSettingsSavedAtLabel(new Date().toLocaleTimeString());
    setStatusLine("配置已保存");
    return nextConfig;
  }

  function syncTimer(baseStartedAtMs = startedAtMs) {
    if (!sessionRef.current) {
      setElapsedLabel("00:00:00");
      return;
    }
    if (sessionRef.current.remoteMeetingId) {
      const clock = recordingClockRef.current;
      setElapsedLabel(
        formatElapsed(
          clock.seconds * 1000 +
            (recorder.running ? Date.now() - clock.updatedAt : 0),
        ),
      );
    } else {
      setElapsedLabel(formatElapsed(Date.now() - baseStartedAtMs));
    }
  }

  function startTimerLoop(baseStartedAtMs) {
    clearInterval(timerRef.current);
    timerRef.current = window.setInterval(
      () => syncTimer(baseStartedAtMs),
      1000,
    );
    syncTimer(baseStartedAtMs);
  }

  function stopTimerLoop() {
    clearInterval(timerRef.current);
    timerRef.current = null;
  }

  function appendError(message) {
    const currentSession = sessionRef.current;
    if (currentSession) {
      currentSession.errors.push({
        time: new Date().toISOString(),
        message,
      });
      updateSession(currentSession);
    }
    setStatusLine(message);
  }

  async function handleTranscript(text, payload = {}) {
    if (payload.cumulative && payload.meeting) {
      pendingTranscriptRef.current = "";
      queueRef.current = queueRef.current.then(async () => {
        const currentSession = sessionRef.current;
        if (
          !currentSession ||
          currentSession.remoteMeetingId !== payload.meeting_id ||
          currentSession.remoteBaseUrl !== payload.baseUrl ||
          payload.meeting.transcript_revision < currentSession.transcriptRevision
        )
          return;
        const next = sessionFromMeeting(payload.meeting, payload.baseUrl, currentSession);
        if (next.minutes && next.minutesFileRevision != null)
          next.minutesStale = next.minutesFileRevision !== next.contentRevision;
        await updateSession(next);
      });
      await queueRef.current;
      return;
    }
  }

  function handleTranscriptPreview(text) {
    setLivePreview(text || "");
    if (text && recordingRef.current) {
      setStatusLine("语音识别中...");
    }
  }

  function handleRecorderEvent(event) {
    if (!event?.type) return;
    const current = sessionRef.current;
    if (event.meeting_id && (current?.remoteMeetingId !== event.meeting_id || current.remoteBaseUrl !== event.baseUrl)) return;

    if (event.type === "meeting" && sessionRef.current) {
      const meeting = event.meeting;
      if (event.updateClock !== false) {
        recordingClockRef.current = {
          seconds: meeting.duration_seconds || 0,
          updatedAt: Date.now(),
        };
      }
      return;
    }

    if (event.type === "minutes" && current) {
      void updateSession(sessionWithMinutes(current, event.minutes));
      return;
    }
    if (event.type === "minutes-error" && current) {
      void updateSession({ ...current, minutesError: event.text });
      return;
    }
    if (event.type === "deleted") {
      sessionLoadRef.current++;
      setSession(null);
      sessionRef.current = null;
      setSessions((rows) => rows.filter((row) => row.id !== event.meeting_id));
      setActiveView("history");
      refreshCatalog();
      setStatusLine("会议记录已删除");
      return;
    }

    if (event.type === "status" && event.text) {
      setStatusLine(event.text);
      return;
    }

    if (event.type === "flow" && event.text) {
      setStatusLine(event.text);
      return;
    }

    if (event.type === "disconnected") {
      stopTimerLoop();
      appendError(event.text);
      return;
    }

    if (event.type === "error" && event.text) {
      appendError(event.text);
    }
  }

  async function exportAudio() {
    const target = sessionRef.current;
    if (!meetingApi || !target?.remoteMeetingId || exportingAudio) return;
    setExportingAudio(true);
    try {
      await meetingApi.downloadAudio(target.remoteMeetingId);
      setStatusLine("已发起录音下载，请在保存窗口中选择位置");
    } catch (error) {
      setStatusLine(`导出录音失败：${error.message}`);
    } finally {
      setExportingAudio(false);
    }
  }

  async function startMeeting() {
    if (startingRef.current || recordingRef.current) return;
    const current = sessionRef.current;
    if (!current?.remoteMeetingId || current.remoteStatus === "ended") {
      requestCreate();
      return;
    }
    startingRef.current = true;
    setIsStarting(true);
    setStatusLine("正在连接会议…");
    try {
      const currentConfig = await saveConfig(formConfig);
      if (current.remoteBaseUrl !== currentConfig.stt.baseUrl)
        throw new Error("会议服务已切换，请重新打开会议");
      await recorder.configure({
        ...currentConfig.stt,
        language: current.language || "auto",
      });
      setIsRecording(true);
      recordingRef.current = true;
      setLivePreview("");
      setActiveView("overview");
      await recorder.start(
        currentConfig.chunkSeconds,
        handleTranscript,
        handleTranscriptPreview,
        handleRecorderEvent,
        current.title,
        { meetingId: current.remoteMeetingId },
      );
      const start = new Date(current.startedAt).getTime();
      setStartedAtMs(start);
      startTimerLoop(start);
      setStatusLine("录音进行中");
    } catch (error) {
      stopTimerLoop();
      const retryable = Boolean(
        recorder.meeting && recorder.meeting.status !== "ended",
      );
      setIsRecording(retryable);
      recordingRef.current = retryable;
      appendError(`启动失败：${error.message}`);
    } finally {
      startingRef.current = false;
      setIsStarting(false);
    }
  }

  async function stopMeeting() {
    if (!sessionRef.current || !recordingRef.current || controllingRef.current)
      return;
    controllingRef.current = true;
    setIsControlling(true);
    setStatusLine("正在结束会议...");
    stopTimerLoop();
    setLivePreview("");

    try {
      await recorder.stop();
      await queueRef.current;
      const currentSession = sessionRef.current;
      currentSession.status = "completed";
      currentSession.remoteStatus = "ended";
      currentSession.endedAt =
        recorder.meeting?.ended_at || new Date().toISOString();
      currentSession.endedAtLabel = new Date(
        currentSession.endedAt,
      ).toLocaleString();
      setIsRecording(false);
      recordingRef.current = false;
      syncTimer();
      await refreshBridgeState();
      await updateSession(currentSession);
      refreshCatalog();
      setStatusLine(
        currentSession.transcript.length
          ? "会议已结束，后台将校正说话人并生成会议总结"
          : "会议已结束，本次未检测到语音",
      );
      void reloadSessions();
    } catch (error) {
      appendError(`结束失败，可重试结束或继续录音: ${error.message || error}`);
    } finally {
      controllingRef.current = false;
      setIsControlling(false);
    }
  }

  useEffect(() => {
    if (!meetingApi) return;
    const controller = new AbortController();
    setDiarizationReady(null);
    meetingApi.diarizationStatus({ signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setDiarizationReady(result); })
      .catch((error) => { if (!controller.signal.aborted) setDiarizationReady({ available: false, error: `无法读取说话人服务状态：${error.message}` }); });
    return () => controller.abort();
  }, [meetingApi]);

  useEffect(() => {
    if (!meetingApi || !session?.remoteMeetingId || session.remoteStatus !== "ended") return;
    const id = session.remoteMeetingId;
    let disposed = false;
    async function observe() {
      // The recording connection becomes read-only after end; keep it alive.
      if (recorder.meeting?.id === id && recorder.socket?.readyState === WebSocket.OPEN) return;
      const meeting = await meetingApi.get(id);
      if (disposed) return;
      await recorder.configure(meetingApi.config);
      if (disposed) return;
      await recorder.observe(meeting, handleTranscript, handleTranscriptPreview, handleRecorderEvent);
    }
    void observe().catch((error) => { if (!disposed) setStatusLine(`会议状态同步失败：${error.message}`); });
    return () => {
      disposed = true;
      if (recorder.meeting?.id === id && recorder.meeting?.status === "ended") recorder.disconnect();
    };
  }, [meetingApi, session?.remoteMeetingId, session?.remoteStatus, sessionSelection]);

  async function retryDiarization() {
    if (retryingDiarization || recorder.meeting?.id !== sessionRef.current?.remoteMeetingId) return;
    setRetryingDiarization(true);
    try {
      await recorder.retryDiarization();
      const result = await meetingApi.diarizationStatus();
      setDiarizationReady(result);
    } catch (error) {
      setStatusLine(`说话人校正失败：${error.message}`);
    } finally {
      setRetryingDiarization(false);
    }
  }

  async function generateReport() {
    const target = sessionRef.current;
    if (!meetingApi || !target?.remoteMeetingId || reportTask.running) return;
    setReportTask({ running: true, text: "正在提交总结任务" });
    try {
      if (recorder.meeting?.id !== target.remoteMeetingId) throw new Error("正在连接会议，请稍后重试");
      await recorder.generateMinutes();
      refreshCatalog();
      setStatusLine("总结任务已提交到服务端");
    } catch (error) {
      setStatusLine(`生成会议总结失败：${error.message}`);
    } finally {
      setReportTask({ running: false, text: "" });
    }
  }

  async function togglePause() {
    if (!sessionRef.current || controllingRef.current) return;
    controllingRef.current = true;
    setIsControlling(true);
    try {
      if (recorder.isPaused()) await recorder.resume();
      else await recorder.pause();
      await refreshBridgeState();
    } catch (error) {
      appendError(`录音操作失败: ${error.message || error}`);
    } finally {
      controllingRef.current = false;
      setIsControlling(false);
    }
  }

  async function testProvider(kind) {
    const currentConfig = await saveConfig(formConfig);
    const targetConfig = currentConfig.stt;
    const label = "语音转写服务";

    setProviderProbe((current) => ({
      ...current,
      [kind]: {
        tone: "",
        text: `正在测试 ${label}...`,
      },
    }));

    try {
      const result = await recorder.probe(targetConfig);
      const success = result.ok === true;
      const text = success ? "连接成功" : "连接失败";
      setProviderProbe((current) => ({
        ...current,
        [kind]: {
          tone: success ? "ok" : "error",
          text,
        },
      }));
      setStatusLine(text);
    } catch {
      setProviderProbe((current) => ({
        ...current,
        [kind]: {
          tone: "error",
          text: "连接失败",
        },
      }));
      setStatusLine("连接失败");
    }
  }

  function requestCreate() {
    if (startingRef.current || recordingRef.current || controllingRef.current) {
      setStatusLine("请先结束当前会议，再新建会议");
      return;
    }
    setCreateOpen(true);
  }

  async function createMeeting(title, departmentId) {
    if (startingRef.current || recordingRef.current || controllingRef.current)
      throw new Error("请先结束当前会议");
    const loadId = ++sessionLoadRef.current;
    let next;
    if (meetingApi) {
      const remote = await meetingApi.create(title, departmentId);
      next = sessionFromMeeting(remote, meetingApi.config.baseUrl);
    } else throw new Error("请先在模型设置中配置有效的会议服务地址");
    if (loadId !== sessionLoadRef.current) return;
    await updateSession(next, { syncView: false });
    showSession(next);
    refreshCatalog();
    setStatusLine("会议已创建，可以开始录音");
  }

  async function openRemoteMeeting(item) {
    if (startingRef.current || recordingRef.current || controllingRef.current) {
      if (sessionRef.current?.remoteMeetingId === item.id)
        setActiveView("overview");
      else setStatusLine("请先结束当前会议，再打开其他记录");
      return;
    }
    const loadId = ++sessionLoadRef.current;
    try {
      const remote = await meetingApi.get(item.id);
      if (loadId !== sessionLoadRef.current) return;
      const previous = sessions.find(
        (row) =>
          row.data?.remoteMeetingId === item.id &&
          row.data?.remoteBaseUrl === meetingApi.config.baseUrl,
      )?.data;
      const next = sessionFromMeeting(
        remote,
        meetingApi.config.baseUrl,
        previous,
      );
      const minutes = await meetingApi.minutes(item.id);
      if (loadId !== sessionLoadRef.current) return;
      Object.assign(next, sessionWithMinutes(next, minutes));
      await updateSession(next, { syncView: false });
      if (
        loadId === sessionLoadRef.current &&
        !recordingRef.current &&
        !startingRef.current
      )
        showSession(next);
    } catch (error) {
      if (loadId === sessionLoadRef.current)
        setStatusLine(`会议加载失败：${error.message}`);
    }
  }

  function loadSessionById(id) {
    return openRemoteMeeting({ id });
  }

  function showSession(nextSession) {
    recorder.disconnect();
    setSessionSelection((value) => value + 1);
    setSession(nextSession);
    sessionRef.current = nextSession;
    setIsRecording(false);
    recordingRef.current = false;
    pendingTranscriptRef.current = "";
    const nextStartedAtMs = nextSession.startedAt
      ? new Date(nextSession.startedAt).getTime()
      : Date.now();
    recordingClockRef.current = {
      seconds: nextSession.durationSeconds || 0,
      updatedAt: Date.now(),
    };
    setStartedAtMs(nextStartedAtMs);
    stopTimerLoop();
    setActiveFocusTab("transcript");
    setLivePreview("");
    setActiveView("overview");
    setStatusLine(`已载入历史会话：${deriveSessionTitle(nextSession)}`);
    const duration =
      nextSession.durationSeconds ??
      (nextSession.endedAt
        ? Math.max(
            0,
            new Date(nextSession.endedAt).getTime() - nextStartedAtMs,
          ) / 1000
        : 0);
    setElapsedLabel(formatElapsed(duration * 1000));
  }

  async function openMinutesWindow() {
    if (!session?.minutes) return;
    await window.meetingDesktop.openMinutesWindow({
      title: deriveSessionTitle(session),
      minutes: session.minutes,
      startedAtLabel: session.startedAtLabel,
      endedAtLabel: session.endedAtLabel,
    });
  }

  async function minimizeWindow() {
    await window.meetingDesktop?.minimizeWindow?.();
  }

  async function toggleMaximize() {
    const next = await window.meetingDesktop?.toggleMaximize?.();
    if (typeof next?.isMaximized === "boolean") {
      setIsMaximized(next.isMaximized);
    }
  }

  async function closeWindow() {
    await window.meetingDesktop?.closeWindow?.();
  }

  const paused = recorder.isPaused();
  const correcting = ["queued", "running"].includes(session?.processing?.status);
  const summaryBusy =
    correcting || reportTask.running || session?.minutesStatus === "generating";
  const processingText = {
    pending: "说话人标注中",
    queued: "等待校正说话人",
    running: "正在校正说话人",
    ready: "说话人校正已完成",
    failed: "说话人校正未完成",
    unavailable: "说话人识别未就绪",
  }[session?.processing?.status] || (diarizationReady?.available === false ? "说话人识别未就绪" : "");
  const tone = sectionTone(
    isRecording,
    paused,
    Boolean(session),
    session?.remoteStatus,
  );
  const sessionTitle = session ? deriveSessionTitle(session) : "会议工作台";
  const transcripts = session?.transcript || [];
  const textCount = transcripts.reduce(
    (total, item) => total + Array.from(item.text).length,
    0,
  );
  const recordingActive = isRecording && !paused && !isControlling;
  const statusError = /失败|错误|EOF|断开|超时/i.test(statusLine);
  const navigation = [
    { key: "history", label: "会议管理", icon: FolderClosed },
    { key: "departments", label: "部门管理", icon: Building2 },
  ];
  const selectedNavigation = activeView === "overview" ? "history" : activeView;
  const currentPage =
    activeView === "settings"
      ? "模型设置"
      : activeView === "overview"
        ? "会议工作台"
        : navigation.find((item) => item.key === activeView)?.label;
  const dateLabel = new Date().toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  if (!ready) {
    return (
      <main className="loading-screen">
        <WorkspaceBrand />
        <span>
          <LoaderCircle className="animate-spin" size={16} />
          正在准备工作空间…
        </span>
      </main>
    );
  }

  return (
    <div className="desktop-app">
      <header
        className="window-titlebar"
        style={{ WebkitAppRegion: "drag" }}
        onDoubleClick={toggleMaximize}
      >
        <span>
          <AudioLines size={14} />
          会议助手
        </span>
        <div className="window-actions" style={{ WebkitAppRegion: "no-drag" }}>
          <button
            onClick={minimizeWindow}
            aria-label="最小化窗口"
            title="最小化"
          >
            <Minus size={15} />
          </button>
          <button
            onClick={toggleMaximize}
            aria-label={isMaximized ? "还原窗口" : "最大化窗口"}
            title={isMaximized ? "还原" : "最大化"}
          >
            <Maximize2 size={13} />
          </button>
          <button
            className="window-close"
            onClick={closeWindow}
            aria-label="关闭窗口"
            title="关闭"
          >
            <X size={15} />
          </button>
        </div>
      </header>

      <CreateMeetingDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        departments={departments}
        loading={departmentsLoading}
        departmentError={departmentsError}
        onRefresh={refreshCatalog}
        onCreate={createMeeting}
        initialTitle={""}
      />
      <div className="app-layout">
        <aside className="workspace-sidebar">
          <WorkspaceBrand />
          <div className="sidebar-section-label">工作空间</div>
          <nav className="workspace-nav" aria-label="主导航">
            {navigation.map(({ key, label, icon: Icon, count }) => (
              <button
                key={key}
                className={`nav-item${selectedNavigation === key ? " selected" : ""}`}
                aria-current={selectedNavigation === key ? "page" : undefined}
                onClick={() => setActiveView(key)}
              >
                <Icon size={16} />
                <span>{label}</span>
                {count !== undefined && <small>{count}</small>}
              </button>
            ))}
          </nav>
          <Separator className="sidebar-divider" />
          <div className="sidebar-section-label">最近会议</div>
          <div className="recent-meetings">
            {sessions.length ? (
              sessions.slice(0, 4).map((item) => (
                <button
                  key={item.id}
                  onClick={() => loadSessionById(item.id)}
                  title={deriveSessionTitle(item.data || item)}
                >
                  <FileText size={14} />
                  <span>{deriveSessionTitle(item.data || item)}</span>
                </button>
              ))
            ) : (
              <p>你的会议记录会出现在这里</p>
            )}
          </div>
          <div className="sidebar-bottom">
            <button
              className={`nav-item${activeView === "settings" ? " selected" : ""}`}
              onClick={() => setActiveView("settings")}
            >
              <Settings size={16} />
              <span>模型设置</span>
            </button>
            <div className="workspace-note">
              <CheckCheck size={15} />
              <span>
                会议服务同步<small>转写与总结均由服务端保存</small>
              </span>
            </div>
          </div>
        </aside>

        <main className="main-workspace">
          <header className="workspace-topbar">
            <nav className="breadcrumb" aria-label="面包屑">
              <PanelLeft size={15} />
              <span>工作空间</span>
              <ChevronRight size={12} />
              <strong>{currentPage}</strong>
            </nav>
            <span className="topbar-date">
              <CalendarDays size={13} />
              {dateLabel}
            </span>
          </header>
          <nav className="compact-navigation" aria-label="紧凑导航">
            {navigation.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                aria-current={selectedNavigation === key ? "page" : undefined}
                onClick={() => setActiveView(key)}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
            <button
              onClick={() => setActiveView("settings")}
              aria-current={activeView === "settings" ? "page" : undefined}
            >
              <Settings size={16} />
              模型设置
            </button>
          </nav>

          {statusError && (
            <div className="status-alert" role="alert">
              <span>{statusLine}</span>
            </div>
          )}

          {activeView === "overview" && (
            <section className="page-content meeting-page">
              <div className="page-heading">
                <div className="min-w-0">
                  <div className="heading-eyebrow">
                    <button
                      className="back-to-meetings"
                      onClick={() => setActiveView("history")}
                      aria-label="返回会议管理"
                    >
                      <ArrowLeft size={14} />
                    </button>
                    <Badge variant={tone.variant}>
                      <span
                        className={`badge-dot${recordingActive ? " pulsing" : ""}`}
                      />
                      {tone.label}
                    </Badge>
                    <span>{session ? "当前会议" : "专注交流，轻松记录"}</span>
                  </div>
                  <h1 title={sessionTitle}>{sessionTitle}</h1>
                  <div className="meeting-meta">
                    {session ? (
                      <>
                        <span>
                          <CalendarDays size={13} />
                          {session.startedAtLabel}
                        </span>
                        <span>
                          <Building2 size={13} />
                          {departments.find(
                            (item) => item.id === session.departmentId,
                          )?.name ||
                            session.departmentName ||
                            "未分类"}
                        </span>
                        <span>
                          <Languages size={13} />
                          {STT_LANGUAGE_OPTIONS.find(
                            (item) =>
                              item.value === (session.language || "auto"),
                          )?.label || "自动识别"}
                        </span>
                      </>
                    ) : (
                      <p>开启录音，实时记录讨论内容。结束后生成会议总结。</p>
                    )}
                  </div>
                </div>
                {session?.minutes && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="heading-action"
                    onClick={openMinutesWindow}
                  >
                    <ArrowUpRight size={15} />
                    查看会议总结
                  </Button>
                )}
                {session?.audioAvailable && meetingApi && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="heading-action"
                    disabled={exportingAudio}
                    onClick={exportAudio}
                  >
                    <Download size={15} />
                    {exportingAudio ? "正在准备…" : "导出录音（WAV）"}
                  </Button>
                )}
              </div>

              <div className="meeting-workspace">
                <Tabs
                  value={activeFocusTab}
                  onValueChange={setActiveFocusTab}
                  className="meeting-content"
                >
                  <TabsList className="w-fit">
                    <TabsTrigger value="transcript">
                      <AudioLines size={14} />
                      实时转写
                    </TabsTrigger>
                    <TabsTrigger value="minutes">
                      <Sparkles size={14} />
                      会议总结
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="transcript" className="meeting-panel">
                    <Card className="document-card">
                      <div className="document-heading">
                        <h2>
                          <FileText size={16} />
                          转写记录
                          {recordingActive && (
                            <span className="live-label">
                              <i />
                              实时
                            </span>
                          )}
                        </h2>
                        <label className="scroll-toggle">
                          <span>自动跟随</span>
                          <Switch
                            size="sm"
                            checked={autoScroll}
                            onCheckedChange={setAutoScroll}
                            aria-label="自动跟随转写"
                          />
                        </label>
                      </div>
                      <div
                        className="document-scroll panel-scroll"
                        ref={transcriptScrollRef}
                      >
                        {!transcripts.length && !livePreview ? (
                          <EmptyDocument
                            icon={AudioLines}
                            title={
                              recordingActive
                                ? "正在聆听你的声音"
                                : session && !isRecording
                                  ? "这场会议暂无转写内容"
                                  : "让讨论自然发生"
                            }
                            description={
                              recordingActive
                                ? "说点什么，文字会在这里慢慢展开。"
                                : "开启录音后，每一个想法都会在这里留下痕迹。"
                            }
                          />
                        ) : (
                          <article
                            className="transcript-document"
                            aria-label="会议转写文本"
                            tabIndex={0}
                          >
                            {transcripts.map((item) => (
                              <div className="transcript-entry" key={item.segment_id} data-segment-id={item.segment_id}>
                                <div className="transcript-meta">
                                  <span className="speaker-label">{item.speakerLabel}</span>
                                  <time>{item.timeLabel}</time>
                                </div>
                                <p>{item.text}</p>
                              </div>
                            ))}
                            {livePreview && (
                              <div className="transcript-entry live-preview">
                                <time>识别中</time>
                                <p>{livePreview}</p>
                              </div>
                            )}
                          </article>
                        )}
                      </div>
                      <div className="document-footer">
                        <span>
                          <CheckCheck size={13} />
                          {transcripts.length
                            ? "转写内容已保存"
                            : "等待会议开始"}
                        </span>
                        <span>
                          {textCount.toLocaleString()} 字 · {transcripts.length}{" "}
                          段
                        </span>
                      </div>
                    </Card>
                    {processingText && (
                      <div className="processing-note" role="status" aria-label="说话人处理状态">
                        <div>
                          <strong>{processingText}</strong>
                          {(session?.processing?.error || diarizationReady?.error) && (
                            <p>{session?.processing?.error || diarizationReady?.error}</p>
                          )}
                        </div>
                        {session?.remoteStatus === "ended" && ["failed", "unavailable"].includes(session?.processing?.status) && (
                          <Button variant="outline" size="sm" disabled={retryingDiarization || correcting} onClick={retryDiarization}>
                            {retryingDiarization && <LoaderCircle size={14} className="animate-spin" />}
                            重试说话人校正
                          </Button>
                        )}
                      </div>
                    )}
                  </TabsContent>
                  <TabsContent value="minutes" className="meeting-panel">
                    <Card className="document-card">
                      <div className="document-heading">
                        <h2>
                          <Sparkles size={16} />
                          会议总结
                        </h2>
                        {session && !isRecording && transcripts.length > 0 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={
                              summaryBusy ||
                              session?.remoteStatus !== "ended" ||
                              !transcripts.length
                            }
                            onClick={() => generateReport()}
                          >
                            {summaryBusy ? (
                              <LoaderCircle
                                size={14}
                                className="animate-spin"
                              />
                            ) : (
                              <RefreshCw size={14} />
                            )}
                            {session.minutes ? "重新生成" : "生成总结"}
                          </Button>
                        )}
                      </div>
                      <div className="document-scroll panel-scroll">
                        {session?.minutesStale && <p className="minutes-notice" role="status">转写已更新，可重新生成纪要。</p>}
                        {session?.minutesError && (
                          <p className="management-error" role="alert">
                            {session.minutesError}
                          </p>
                        )}
                        {session?.minutes ? (
                          <article
                            className="minutes-document"
                            aria-label="会议总结正文"
                            tabIndex={0}
                          >
                            <MinutesMarkdown text={session.minutes} />
                          </article>
                        ) : (
                          <EmptyDocument
                            icon={summaryBusy ? LoaderCircle : Sparkles}
                            title={
                              correcting
                                ? "正在校正说话人"
                                : summaryBusy
                                ? "正在整理会议内容"
                                : "让会议有清晰的下一步"
                            }
                            description={
                              correcting
                                ? "校正完成后将生成会议总结。"
                                : summaryBusy
                                ? "正在提炼核心结论、决策与待办，请稍候。"
                                : "结束会议后，将完整转写整理为核心结论、决策、待办和下一步安排。"
                            }
                          />
                        )}
                      </div>
                      <div className="document-footer">
                        <span>
                          <CheckCheck size={13} />
                          {correcting
                            ? "正在校正说话人"
                            : summaryBusy
                            ? "正在生成总结"
                            : session?.minutes
                              ? "会议总结已保存"
                              : "等待生成总结"}
                        </span>
                        {session?.minutes && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={openMinutesWindow}
                          >
                            <ArrowUpRight size={14} />
                            独立窗口
                          </Button>
                        )}
                      </div>
                    </Card>
                  </TabsContent>
                </Tabs>

                <div className="meeting-aside panel-scroll">
                  <Card className="recording-card">
                    <div className="recording-card-heading">
                      <h2>
                        <Mic size={15} />
                        录音控制
                      </h2>
                      <i
                        className={`recording-indicator${recordingActive ? " active" : ""}`}
                      />
                    </div>
                    <div className="recording-timer">
                      <strong>{elapsedLabel}</strong>
                      <span>会议录音时长</span>
                    </div>
                    <RecordingWave active={recordingActive} />
                    <div className="recording-controls">
                      <Button
                        onClick={() =>
                          session && session.status !== "completed"
                            ? startMeeting()
                            : requestCreate()
                        }
                        disabled={isStarting || isRecording}
                        aria-busy={isStarting}
                      >
                        {isStarting ? (
                          <LoaderCircle size={16} className="animate-spin" />
                        ) : (
                          <Mic size={16} />
                        )}
                        {isStarting
                          ? "正在连接..."
                          : session && session.status !== "completed"
                            ? session.remoteStatus === "paused"
                              ? "继续会议"
                              : "开始会议"
                            : "新建会议"}
                      </Button>
                      <div className="recording-secondary-actions">
                        <Button
                          variant="outline"
                          onClick={togglePause}
                          disabled={isStarting || isControlling || !isRecording}
                        >
                          {paused ? <Play size={15} /> : <Pause size={15} />}
                          {paused ? "继续" : "暂停"}
                        </Button>
                        <Button
                          variant="destructive"
                          onClick={stopMeeting}
                          disabled={isStarting || isControlling || !isRecording}
                        >
                          {isControlling ? (
                            <LoaderCircle size={14} className="animate-spin" />
                          ) : (
                            <Square size={13} />
                          )}
                          结束会议
                        </Button>
                      </div>
                    </div>
                    <p className="recording-hint">
                      {isStarting
                        ? "正在连接服务并准备麦克风。"
                        : paused && isRecording
                          ? "麦克风已暂停，继续后会接着记录。"
                          : recordingActive
                            ? "安心交流，会议内容正在被记录。"
                            : session
                              ? "已保存的内容可以随时回看。"
                              : "准备好后，开启麦克风。转写内容会实时显示。"}
                    </p>
                    <div className="microphone-status">
                      {recordingActive ? (
                        <Mic size={13} />
                      ) : (
                        <MicOff size={13} />
                      )}
                      {recordingActive
                        ? "麦克风采集中"
                        : paused && isRecording
                          ? "麦克风已暂停"
                          : "麦克风未开启"}
                    </div>
                  </Card>
                  {summaryBusy && (
                    <Card className="report-progress" role="status">
                      <div>
                        <Sparkles size={14} />
                        <strong>正在生成总结</strong>
                        <span>服务端处理中</span>
                      </div>
                      <p>转写与总结均保存在服务端，生成完成后会自动刷新。</p>
                    </Card>
                  )}
                  <div className="meeting-guide">
                    <span>
                      <FileText size={15} />
                      从讨论到行动
                    </span>
                    <p>实时转写保留完整记录，会议总结帮你梳理重点与下一步。</p>
                    <button onClick={() => setActiveView("settings")}>
                      管理模型设置
                      <ChevronRight size={12} />
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}

          {activeView === "history" && (
            <MeetingManagement
              key={config.stt.baseUrl}
              api={meetingApi}
              departments={departments}
              revision={catalogRevision}
              onOpen={openRemoteMeeting}
              onCreate={requestCreate}
              onCurrent={() => setActiveView("overview")}
              hasCurrent={!!session}
              busy={isStarting || isRecording}
            />
          )}
          {activeView === "departments" && (
            <DepartmentManagement
              key={config.stt.baseUrl}
              api={meetingApi}
              departments={departments}
              loading={departmentsLoading}
              error={departmentsError}
              onChanged={refreshCatalog}
            />
          )}

          {activeView === "settings" && (
            <section className="page-content settings-page">
              <div className="page-heading">
                <div>
                  <h1>模型设置</h1>
                  <p>连接语音转写与大语言模型，搭建你的会议工作流。</p>
                </div>
                {settingsTab === "stt" ? (
                  <Button size="sm" onClick={() => saveConfig()}>
                    <Save size={14} />
                    保存配置
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    type="submit"
                    form={LLM_SETTINGS_FORM_ID}
                    disabled={!llmSaveState.canSave}
                  >
                    {llmSaveState.busy ? (
                      <LoaderCircle size={14} className="animate-spin" />
                    ) : (
                      <Save size={14} />
                    )}
                    {llmSaveState.busy ? "正在保存…" : "保存配置"}
                  </Button>
                )}
              </div>
              <Tabs
                value={settingsTab}
                onValueChange={setSettingsTab}
                className="settings-tabs"
              >
                <TabsList className="w-fit">
                  <TabsTrigger value="stt">
                    <AudioLines size={14} />
                    语音转写
                  </TabsTrigger>
                  <TabsTrigger value="llm">
                    <Sparkles size={14} />
                    大语言模型
                  </TabsTrigger>
                </TabsList>
                <TabsContent
                  value="stt"
                  className="settings-panel panel-scroll"
                >
                  <Card className="settings-card">
                    <CardHeader>
                      <div className="settings-card-heading">
                        <span className="settings-icon">
                          <AudioLines size={20} />
                        </span>
                        <div>
                          <CardTitle>语音转写服务</CardTitle>
                          <CardDescription>
                            将会议录音实时转换为文字。
                          </CardDescription>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => testProvider("stt")}
                        >
                          测试连接
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="settings-form-grid">
                        <Field label="接口地址">
                          <Input
                            value={formConfig.stt.baseUrl}
                            onChange={(event) =>
                              updateForm("stt.baseUrl", event.target.value)
                            }
                            placeholder="http://127.0.0.1:8000"
                          />
                        </Field>
                        <Field label="识别语言">
                          <Select
                            value={formConfig.stt.language}
                            onValueChange={(value) =>
                              updateForm("stt.language", value)
                            }
                          >
                            <SelectTrigger aria-label="识别语言">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {STT_LANGUAGE_OPTIONS.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      </div>
                      <div
                        className={`provider-status ${providerProbe.stt.tone}`}
                        role="status"
                      >
                        <i />
                        {providerProbe.stt.text}
                      </div>
                    </CardContent>
                  </Card>
                  <details className="media-diagnostics">
                    <summary>
                      <Mic size={14} />
                      麦克风与环境诊断
                    </summary>
                    <p>{mediaProbeText}</p>
                    <small>
                      {platform} · {mediaSupport.message}
                    </small>
                  </details>
                </TabsContent>
                <TabsContent
                  value="llm"
                  className="settings-panel panel-scroll"
                >
                  <ServerModelSettings
                    api={meetingApi}
                    onSaveStateChange={setLlmSaveState}
                  />
                </TabsContent>
              </Tabs>
              <div className="settings-save-note">
                <CheckCheck size={13} />
                {settingsTab === "llm"
                  ? "大语言模型配置由会议服务统一管理。"
                  : settingsSavedAtLabel
                    ? `配置已保存于 ${settingsSavedAtLabel}`
                    : "修改后点击「保存配置」，下次会议将使用新配置。"}
              </div>
            </section>
          )}

          <footer
            className="workspace-statusbar"
            role="status"
            aria-live="polite"
          >
            <span>
              <i className={recordingActive ? "pulsing" : ""} />
              {statusError ? "操作未完成，请查看上方提示" : statusLine}
            </span>
            <span>会议助手</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
