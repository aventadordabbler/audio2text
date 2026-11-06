import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Building2,
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
  ChevronRight,
  FolderClosed,
  Languages,
  LogOut,
  MicOff,
  PanelLeft,
  RefreshCw,
  Sparkles,
  Copy,
  Download,
  Plus,
  MicVocal,
} from "lucide-react";
import {
  WorkspaceBrand,
  EmptyDocument,
  RecordingWave,
} from "@/components/workspace-ui.jsx";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import MinutesMarkdown from "@/components/minutes-markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DesktopStore } from "@/services/desktop-store.js";
import { MeetingRecorder } from "@/services/meeting-recorder.js";
import { StageSummaryFeed } from "@/services/stage-summary-feed.js";
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
  importStatusLabel,
} from "@/services/meeting-catalog.js";
import {
  MeetingManagement,
  CreateMeetingDialog,
} from "@/components/meeting-management.jsx";
import { DepartmentManagement } from "@/components/department-management.jsx";
import { VoiceprintManagement } from "@/components/voiceprint-management.jsx";
import { MinutesFormatManagement } from "@/components/minutes-format-management.jsx";
import { StageSummaryPanel } from "@/components/stage-summary-panel.jsx";

const store = new DesktopStore();
const recorder = new MeetingRecorder();
const stageSummaryFeed = new StageSummaryFeed();

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
  const [authUser, setAuthUser] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ account: "", password: "", department: "", employeeId: "" });
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authNotice, setAuthNotice] = useState("");
  const [passwordSetup, setPasswordSetup] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [connectionSettingsOpen, setConnectionSettingsOpen] = useState(false);
  const [connectionUrl, setConnectionUrl] = useState(DEFAULT_CONFIG.stt.baseUrl);
  const [connectionSettingsError, setConnectionSettingsError] = useState("");
  const [connectionSettingsBusy, setConnectionSettingsBusy] = useState(false);
  const [slogan, setSlogan] = useState("");
  const [uploadProgress, setUploadProgress] = useState(null);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [session, setSession] = useState(null);
  const [sessionSelection, setSessionSelection] = useState(0);
  const [sessions, setSessions] = useState([]);
  const [activeView, setActiveView] = useState("history");
  const [activeFocusTab, setActiveFocusTab] = useState("transcript");
  const [departments, setDepartments] = useState([]);
  const [departmentsLoading, setDepartmentsLoading] = useState(false);
  const [departmentsError, setDepartmentsError] = useState("");
  const [minutesFormats, setMinutesFormats] = useState([]);
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
  const [transcriptFollowing, setTranscriptFollowing] = useState(true);
  const transcriptScrollRef = useRef(null);
  const [statusLine, setStatusLine] = useState("待命");
  const [isMaximized, setIsMaximized] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [asrDiagnostics, setAsrDiagnostics] = useState(null);
  const [stageSummaries, setStageSummaries] = useState([]);
  const [stageSummaryState, setStageSummaryState] = useState({
    status: "idle",
    windowSeconds: 0,
    error: "",
  });
  const [retryingStageSummaries, setRetryingStageSummaries] = useState(false);
  const [stageSummaryActionError, setStageSummaryActionError] = useState("");
  const [livePreview, setLivePreview] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isControlling, setIsControlling] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [diarizationReady, setDiarizationReady] = useState(null);
  const [retryingDiarization, setRetryingDiarization] = useState(false);
  const [retryingImport, setRetryingImport] = useState(false);
  const [importPollRevision, setImportPollRevision] = useState(0);
  const [exportingAudio, setExportingAudio] = useState(false);
  const [exportingText, setExportingText] = useState(false);
  const [exportingMinutes, setExportingMinutes] = useState(false);
  const [minutesExportOpen, setMinutesExportOpen] = useState(false);
  const [exportingStageSummaries, setExportingStageSummaries] = useState(false);
  const [exportSuccessMessage, setExportSuccessMessage] = useState("");
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
  const exportSuccessTimerRef = useRef(null);

  useEffect(() => () => clearTimeout(exportSuccessTimerRef.current), []);

  function showExportSuccess(message) {
    clearTimeout(exportSuccessTimerRef.current);
    setExportSuccessMessage(message);
    exportSuccessTimerRef.current = setTimeout(() => {
      setExportSuccessMessage("");
      exportSuccessTimerRef.current = null;
    }, 2000);
  }

  useEffect(() => {
    setDepartments([]);
    setDepartmentsError("");
    if (!authUser || authUser.must_change_password || !ready || !meetingApi) {
      setDepartmentsLoading(false);
      return;
    }
    if (!authUser.is_admin) {
      setDepartments([]);
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
    authUser,
    meetingApi,
    catalogRevision,
    createOpen,
    activeView === "departments",
  ]);

  useEffect(() => {
    setMinutesFormats([]);
    if (!authUser || authUser.must_change_password || !ready || !meetingApi) return undefined;
    const controller = new AbortController();
    meetingApi.minutesFormats({ signal: controller.signal }).then((items) => {
      if (!controller.signal.aborted) setMinutesFormats(items);
    }).catch(() => {
      if (!controller.signal.aborted) setMinutesFormats([]);
    });
    return () => controller.abort();
  }, [ready, authUser, meetingApi, catalogRevision, createOpen]);

  useEffect(() => {
    if (authUser && !authUser.is_admin && (activeView === "departments" || activeView === "voiceprints" || activeView === "minutesFormats"))
      setActiveView("history");
  }, [authUser, activeView]);

  function refreshCatalog() {
    setCatalogRevision((value) => value + 1);
  }

  useEffect(() => {
    if (
      !authUser ||
      !autoScroll ||
      !isRecording ||
      activeView !== "overview" ||
      activeFocusTab !== "transcript" ||
      !transcriptFollowing
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
    transcriptFollowing,
  ]);

  useEffect(() => {
    const viewport = transcriptScrollRef.current;
    if (!viewport) return undefined;
    const updateFollowing = () => {
      const atLatest =
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 48;
      setTranscriptFollowing(atLatest);
    };
    viewport.addEventListener("scroll", updateFollowing, { passive: true });
    updateFollowing();
    return () => viewport.removeEventListener("scroll", updateFollowing);
  }, [sessionSelection, activeView, activeFocusTab]);

  function followTranscript() {
    const viewport = transcriptScrollRef.current;
    if (!viewport) return;
    setAutoScroll(true);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    setTranscriptFollowing(true);
  }

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
    if (!ready || !meetingApi) return;
    if (!localStorage.getItem("meeting-auth-token")) return;
    meetingApi.authMe().then(setAuthUser).catch(() => localStorage.removeItem("meeting-auth-token"));
  }, [ready, meetingApi]);

  useEffect(() => {
    setSlogan("");
    if (!ready || !authUser || !meetingApi) return undefined;
    let active = true;
    meetingApi.settings()
      .then((settings) => {
        if (active) setSlogan(String(settings?.slogan || "").trim());
      })
      .catch(() => {})
    return () => {
      active = false;
    };
  }, [ready, authUser, meetingApi]);

  useEffect(() => {
    const expired = () => {
      recorder.disconnect();
      setAuthUser(null);
    };
    window.addEventListener("auth-expired", expired);
    return () => window.removeEventListener("auth-expired", expired);
  }, []);

  async function submitAuth(event) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");
    try {
      if (authMode === "register") {
        await meetingApi.authRegister(authForm.account, authForm.password, authForm.department, authForm.employeeId);
        setAuthMode("login");
        setAuthForm((current) => ({ ...current, password: "", department: "", employeeId: "" }));
        setAuthNotice("注册成功，请登录");
        return;
      }
      const result = await meetingApi.authLogin(authForm.account, authForm.password);
      localStorage.setItem("meeting-auth-token", result.token);
      setAuthUser(result.user);
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function submitPasswordSetup(event) {
    event.preventDefault();
    if (passwordSetup !== passwordConfirmation) {
      setAuthError("两次输入的密码不一致");
      return;
    }
    setAuthBusy(true);
    setAuthError("");
    try {
      if (!meetingApi) throw new Error("请先配置 audio2text 服务地址");
      const result = await meetingApi.changePassword(passwordSetup);
      setPasswordSetup("");
      setPasswordConfirmation("");
      setAuthUser(result.user);
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function saveConnectionSettings(event) {
    event.preventDefault();
    setConnectionSettingsBusy(true);
    setConnectionSettingsError("");
    try {
      const nextStt = normalizeSttConfig({
        ...config.stt,
        baseUrl: connectionUrl,
      });
      new MeetingApi(nextStt);
      const saved = await saveConfig({ ...config, stt: nextStt });
      setConnectionUrl(saved.stt.baseUrl);
      setConnectionSettingsOpen(false);
    } catch (error) {
      setConnectionSettingsError(error.message || "服务端地址无效");
    } finally {
      setConnectionSettingsBusy(false);
    }
  }

  function logout() {
    recorder.disconnect();
    stageSummaryFeed.disconnect();
    localStorage.removeItem("meeting-auth-token");
    setAuthUser(null);
    setSession(null);
    setSessions([]);
    setSlogan("");
    setAuthError("");
    setAuthNotice("");
    setActiveView("history");
  }

  useEffect(() => {
    const meetingId = session?.remoteMeetingId;
    const baseUrl = session?.remoteBaseUrl;
    setStageSummaryActionError("");
    if (!ready || !meetingId || !baseUrl) {
      stageSummaryFeed.disconnect();
      setStageSummaries([]);
      setStageSummaryState({ status: "idle", windowSeconds: 0, error: "" });
      return;
    }
    const api = new MeetingApi({
      ...configRef.current.stt,
      baseUrl,
    });
    stageSummaryFeed.connect(api, meetingId, {
      onSummaries: setStageSummaries,
      onStatus: (next) =>
        setStageSummaryState((current) => ({ ...current, error: "", ...next })),
    });
    return () => stageSummaryFeed.disconnect();
  }, [ready, session?.remoteMeetingId, session?.remoteBaseUrl, session?.source]);

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

      setConfig(nextConfig);
      setConnectionUrl(nextConfig.stt.baseUrl);
      setSessions([]);
      setStatusLine("准备就绪");
      setReady(true);
    }

    bootstrap();

    return () => {
      disposed = true;
      clearInterval(timerRef.current);
      recorder.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!ready || !authUser || authUser.must_change_password) return;
    recorder.disconnect();
    sessionLoadRef.current++;
    setSessions([]);
    setSession(null);
    sessionRef.current = null;
    void reloadSessions();
  }, [ready, authUser, config.stt.baseUrl]);

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
    const nextConfig = clone(nextConfigOverride || config);
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
    configRef.current = nextConfig;
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
      setElapsedLabel(formatElapsed(clock.seconds * 1000));
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

    if (event.type === "clock" && Number.isFinite(event.seconds)) {
      recordingClockRef.current = {
        seconds: event.seconds,
        updatedAt: Date.now(),
      };
      syncTimer();
      return;
    }

    if (event.type === "diagnostics" && event.asr) {
      setAsrDiagnostics({
        ...event.asr,
        bufferedBytes: event.buffered_bytes || 0,
        updatedAt: new Date().toLocaleTimeString(),
      });
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

  async function exportText() {
    const target = sessionRef.current;
    if (!meetingApi || !target?.remoteMeetingId || exportingText) return;
    setExportingText(true);
    try {
      await meetingApi.downloadTranscript(target.remoteMeetingId);
      setStatusLine("已发起文本下载，请在保存窗口中选择位置");
      showExportSuccess("文本文件已开始下载，请在保存窗口中选择位置。");
    } catch (error) {
      setStatusLine(`导出文本失败：${error.message}`);
    } finally {
      setExportingText(false);
    }
  }

  async function copyTranscript() {
    const target = sessionRef.current;
    const text = (target?.transcript || []).map((item) => item.text).join("\n").trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatusLine("转写内容已复制");
    } catch (error) {
      setStatusLine(`复制转写失败：${error.message}`);
    }
  }

  async function exportAudio() {
    const target = sessionRef.current;
    if (!meetingApi || !target?.remoteMeetingId || exportingAudio) return;
    setExportingAudio(true);
    try {
      await meetingApi.downloadAudio(target.remoteMeetingId);
      setStatusLine("已发起录音下载，请在保存窗口中选择位置");
      showExportSuccess("原始音频已开始下载，请在保存窗口中选择位置。");
    } catch (error) {
      setStatusLine(`导出录音失败：${error.message}`);
    } finally {
      setExportingAudio(false);
    }
  }

  async function exportMinutes(format) {
    const target = sessionRef.current;
    if (!meetingApi || !target?.remoteMeetingId || exportingMinutes) return;
    setMinutesExportOpen(false);
    setExportingMinutes(true);
    try {
      await meetingApi.downloadMinutes(target.remoteMeetingId, format);
      setStatusLine("已发起会议纪要下载，请在保存窗口中选择位置");
      showExportSuccess("会议纪要已开始下载，请在保存窗口中选择位置。");
    } catch (error) {
      setStatusLine(`导出会议纪要失败：${error.message}`);
    } finally {
      setExportingMinutes(false);
    }
  }

  async function exportStageSummaries() {
    const target = sessionRef.current;
    if (!meetingApi || !target?.remoteMeetingId || exportingStageSummaries) return;
    setExportingStageSummaries(true);
    try {
      await meetingApi.downloadStageSummaries(target.remoteMeetingId);
      setStatusLine("已发起阶段总结下载，请在保存窗口中选择位置");
      showExportSuccess("阶段总结已开始下载，请在保存窗口中选择位置。");
    } catch (error) {
      setStatusLine(`导出阶段总结失败：${error.message}`);
    } finally {
      setExportingStageSummaries(false);
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
      const currentConfig = await saveConfig();
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
    setAsrDiagnostics(null);
    setShowDiagnostics(false);

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
      setTranscriptFollowing(true);
      syncTimer();
      await updateSession(currentSession);
      refreshCatalog();
      setActiveFocusTab(currentSession.transcript.length ? "minutes" : "transcript");
      setStatusLine(
        currentSession.transcript.length
          ? "会议已结束，后台将校正说话人并生成会议纪要"
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
    if (!meetingApi || !session?.remoteMeetingId || session.remoteStatus !== "ended" || session.source === "wav") return;
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
  }, [meetingApi, session?.remoteMeetingId, session?.remoteStatus, session?.source, sessionSelection]);

  useEffect(() => {
    if (!meetingApi || session?.source !== "wav" || !session.remoteMeetingId) return;
    const id = session.remoteMeetingId;
    const controller = new AbortController();
    let timer;
    async function poll() {
      try {
        const [remote, minutes] = await Promise.all([
          meetingApi.get(id, { signal: controller.signal }),
          meetingApi.minutes(id, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted || sessionRef.current?.remoteMeetingId !== id) return;
        const next = sessionWithMinutes(sessionFromMeeting(remote, meetingApi.config.baseUrl, sessionRef.current), minutes);
        await updateSession(next);
        if (["queued", "running"].includes(remote.import_job?.status) ||
            ["queued", "running"].includes(remote.processing?.status) || minutes.status === "generating") {
          timer = setTimeout(poll, 1500);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setStatusLine(`导入状态同步失败：${error.message}`);
        timer = setTimeout(poll, 3000);
      }
    }
    void poll();
    return () => { clearTimeout(timer); controller.abort(); };
  }, [meetingApi, session?.remoteMeetingId, session?.source, sessionSelection, importPollRevision]);

  async function retryImport() {
    const target = sessionRef.current;
    if (!meetingApi || !target?.remoteMeetingId || retryingImport) return;
    setRetryingImport(true);
    try {
      const remote = await meetingApi.retryImport(target.remoteMeetingId);
      await updateSession(sessionFromMeeting(remote, meetingApi.config.baseUrl, target));
      setImportPollRevision((value) => value + 1);
    } catch (error) {
      setStatusLine(`重试导入失败：${error.message}`);
    } finally {
      setRetryingImport(false);
    }
  }

  async function retryDiarization() {
    const target = sessionRef.current;
    if (retryingDiarization || !target?.remoteMeetingId || (target.source !== "wav" && recorder.meeting?.id !== target.remoteMeetingId)) return;
    setRetryingDiarization(true);
    try {
      if (target.source === "wav") {
        await meetingApi.retryDiarization(target.remoteMeetingId);
        setImportPollRevision((value) => value + 1);
      } else await recorder.retryDiarization();
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
    setReportTask({ running: true, text: "正在提交纪要任务" });
    try {
      if (target.source === "wav") {
        const minutes = await meetingApi.generateMinutes(target.remoteMeetingId);
        await updateSession(sessionWithMinutes(target, minutes));
        setImportPollRevision((value) => value + 1);
      } else {
        if (recorder.meeting?.id !== target.remoteMeetingId) throw new Error("正在连接会议，请稍后重试");
        await recorder.generateMinutes();
      }
      refreshCatalog();
      setStatusLine("纪要任务已提交到服务端");
    } catch (error) {
      setStatusLine(`生成会议纪要失败：${error.message}`);
    } finally {
      setReportTask({ running: false, text: "" });
    }
  }

  async function retryStageSummaries() {
    const current = sessionRef.current;
    if (!current?.remoteMeetingId || retryingStageSummaries) return;
    setRetryingStageSummaries(true);
    setStageSummaryActionError("");
    try {
      const api = new MeetingApi({
        ...configRef.current.stt,
        baseUrl: current.remoteBaseUrl,
      });
      await api.retryStageSummaries(current.remoteMeetingId);
    } catch (error) {
      setStageSummaryActionError(`阶段总结重试失败：${error.message}`);
    } finally {
      setRetryingStageSummaries(false);
    }
  }

  function jumpToStageSummary(summary) {
    if (!summary) return;
    setActiveFocusTab("transcript");
    const startMs = Number(summary.start_seconds || 0) * 1000;
    const target =
      transcripts.find((item) => Number(item.start_ms || 0) >= startMs) ||
      transcripts[transcripts.length - 1];
    if (!target || target.segment_id === "archive") return;
    window.requestAnimationFrame(() => {
      const viewport = transcriptScrollRef.current;
      const element = [...(viewport?.querySelectorAll("[data-segment-id]") || [])].find(
        (item) => item.dataset.segmentId === String(target.segment_id),
      );
      if (!element) return;
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      element.classList.add("transcript-entry--focus");
      window.setTimeout(() => element.classList.remove("transcript-entry--focus"), 1600);
    });
  }

  async function togglePause() {
    if (!sessionRef.current || controllingRef.current) return;
    controllingRef.current = true;
    setIsControlling(true);
    try {
      if (recorder.isPaused()) {
        await recorder.resume();
        startTimerLoop(startedAtMs);
      } else {
        await recorder.pause();
        stopTimerLoop();
        syncTimer();
      }
    } catch (error) {
      appendError(`录音操作失败: ${error.message || error}`);
    } finally {
      controllingRef.current = false;
      setIsControlling(false);
    }
  }

  function requestCreate() {
    if (startingRef.current || recordingRef.current || controllingRef.current) {
      setStatusLine("请先结束当前会议，再新建会议");
      return;
    }
    setCreateOpen(true);
  }

  async function createMeeting(title, departmentId, files = [], language, minutesFormatId = null) {
    if (startingRef.current || recordingRef.current || controllingRef.current)
      throw new Error("请先结束当前会议");
    setUploadProgress(null);
    const loadId = ++sessionLoadRef.current;
    try {
      let next;
      if (meetingApi) {
        const remote = files.length
          ? await meetingApi.importWav(title, departmentId, files, language, (completed, total) => setUploadProgress({ completed, total }), minutesFormatId)
          : await meetingApi.create(title, departmentId, minutesFormatId);
        next = sessionFromMeeting(remote, meetingApi.config.baseUrl);
      } else throw new Error("请先配置有效的会议服务地址");
      if (loadId !== sessionLoadRef.current) return;
      await updateSession(next, { syncView: false });
      showSession(next);
      refreshCatalog();
      setStatusLine(files.length ? "音频已上传，后台正在生成转写和会议纪要" : "会议已创建，可以开始录音");
    } finally {
      setUploadProgress(null);
    }
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
    setActiveFocusTab(nextSession.remoteStatus === "ended" ? "minutes" : "transcript");
    setTranscriptFollowing(true);
    setLivePreview("");
    setAsrDiagnostics(null);
    setShowDiagnostics(false);
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

  function renderWindowTitlebar() {
    return (
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
    );
  }

  const imported = session?.source === "wav";
  const importJob = session?.importJob;
  const importBusy = ["queued", "running"].includes(importJob?.status);
  const importPending = !!importJob && importJob.status !== "ready";
  const paused = recorder.isPaused();
  const correcting = ["queued", "running"].includes(session?.processing?.status);
  const summaryBusy =
    correcting || reportTask.running || session?.minutesStatus === "generating";
  const processingStatus = session?.processing?.status;
  const processingText = {
    pending: "说话人标注中",
    queued: "等待校正说话人",
    running: "正在校正说话人",
    ready: "说话人校正已完成",
    failed: "说话人校正未完成",
    unavailable: "说话人识别未就绪",
  }[processingStatus] ||
    (diarizationReady?.available === false ? "说话人识别未就绪" : "");
  const speakerStatusWarning =
    ["failed", "unavailable"].includes(processingStatus) ||
    (!processingStatus && diarizationReady?.available === false);
  const speakerStatusActive = ["pending", "queued", "running"].includes(
    processingStatus,
  );
  const speakerStatusError = speakerStatusWarning
    ? session?.processing?.error || diarizationReady?.error || ""
    : "";
  const speakerStatusClassName =
    `speaker-status${speakerStatusActive ? " active" : ""}` +
    (speakerStatusWarning ? " warning" : "");
  const speakerStatusLabel =
    `说话人处理状态：${processingText}` +
    (speakerStatusError ? `。${speakerStatusError}` : "");
  const canRetryDiarization =
    session?.remoteStatus === "ended" && (!imported || importJob?.status === "ready") &&
    ["failed", "unavailable"].includes(processingStatus);
  const tone = sectionTone(
    isRecording,
    paused,
    Boolean(session),
    session?.remoteStatus,
  );
  const sessionTitle = session ? deriveSessionTitle(session) : "会议详情";
  const transcripts = session?.transcript || [];
  const textCount = transcripts.reduce(
    (total, item) => total + Array.from(item.text).length,
    0,
  );
  const recordingActive = isRecording && !paused && !isControlling;
  const diagnosticRows = asrDiagnostics
    ? [
        [
          "模式",
          asrDiagnostics.mode === "transcription" ? "文件转写" : "流式续写",
        ],
        [
          "积压",
          `${asrDiagnostics.pending_seconds} / ${asrDiagnostics.max_pending_seconds} 秒`,
        ],
        ["最近请求", `${Math.round(asrDiagnostics.last_request_ms)} ms`],
        ["平均请求", `${Math.round(asrDiagnostics.average_request_ms)} ms`],
        ["峰值请求", `${Math.round(asrDiagnostics.max_request_ms)} ms`],
        ["发送缓冲", `${asrDiagnostics.bufferedBytes} B`],
      ]
    : [];
  const stageSummaryBubbleError =
    stageSummaryActionError ||
    (stageSummaryState.status === "error" ? stageSummaryState.error : "");
  const statusError = /失败|错误|EOF|断开|超时/i.test(statusLine);
  const processingStates = session
    ? [
        {
          key: "recording",
          label: imported ? "音频已导入" : recordingActive
            ? "录音中"
            : session.remoteStatus === "ended"
              ? "录音完成"
              : session.remoteStatus === "paused"
                ? "已暂停"
                : "准备中",
          tone: recordingActive ? "active" : "ready",
        },
        {
          key: "transcript",
          label: importJob?.stage === "transcribing" && importPending ? importStatusLabel(importJob) : transcripts.length
            ? session.remoteStatus === "ended"
              ? "转写完成"
              : "实时转写"
            : "等待转写",
          tone: importBusy && importJob?.stage === "transcribing" ? "active" : transcripts.length ? "ready" : "neutral",
        },
        {
          key: "speaker",
          label: processingText || "说话人识别待命",
          tone: speakerStatusWarning
            ? "warning"
            : speakerStatusActive
              ? "active"
              : processingStatus === "ready"
                ? "ready"
                : "neutral",
        },
        {
          key: "minutes",
          label: imported && importJob?.stage !== "summarizing" && importPending ? "等待纪要" : summaryBusy
            ? "纪要生成中"
            : session.minutes
              ? "纪要已保存"
              : session.remoteStatus === "ended"
                ? "等待纪要"
                : "会后生成",
          tone: imported && importJob?.stage !== "summarizing" && importPending ? "neutral" : summaryBusy ? "active" : session.minutes ? "ready" : "neutral",
        },
      ]
    : [];
  const navigation = [
    { key: "history", label: "会议管理", icon: FolderClosed },
    ...(authUser?.is_admin ? [{ key: "departments", label: "部门管理", icon: Building2 }] : []),
    ...(authUser?.is_admin ? [{ key: "voiceprints", label: "声纹管理", icon: MicVocal }] : []),
    ...(authUser?.is_admin ? [{ key: "minutesFormats", label: "纪要格式", icon: FileText }] : []),
  ];
  const selectedNavigation = activeView === "overview" ? "history" : activeView;
  const currentPage = activeView === "overview"
    ? "会议详情"
    : navigation.find((item) => item.key === activeView)?.label;
  const dateLabel = new Date().toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  function renderRecordingControl() {
    if (imported) return (
      <Card className="recording-card recording-card--top recording-card--import">
        <div className="recording-card-heading"><h2><FileText size={15} />导入音频</h2>{session?.audioAvailable && meetingApi && <div className="recording-heading-actions"><Button variant="ghost" size="icon-xs" aria-label="下载录音" title="下载录音" aria-busy={exportingAudio} disabled={exportingAudio} onClick={exportAudio}><Download size={13} /></Button></div>}</div>
        <div className="recording-timer"><strong>{formatElapsed((session.durationSeconds || 0) * 1000)}</strong></div>
        <div className="import-progress" role="status">
          <p className="import-filename" title={importJob?.filename}>{importJob?.filename}</p>
          <p>{importBusy && <LoaderCircle size={15} className="animate-spin" />}{importStatusLabel(importJob)}</p>
          {importBusy && importJob?.stage === "transcribing" && <progress aria-label="音频转写进度" max={importJob.total_samples || 1} value={importJob.processed_samples} />}
          {importJob?.error && <p role="alert">{importJob.error}</p>}
          {importJob?.status === "failed" && <Button variant="outline" disabled={retryingImport} onClick={retryImport}>重试处理</Button>}
          {importBusy && <small>可离开页面，后台会继续处理。</small>}
        </div>
      </Card>
    );
    return (
      <Card className="recording-card recording-card--top">
        <div className="recording-card-heading">
          <h2>
            <Mic size={15} />
            录音控制
          </h2>
          <div className="recording-heading-actions">
            {session?.audioAvailable && meetingApi && <Button variant="ghost" size="icon-xs" aria-label="下载录音" title="下载录音" aria-busy={exportingAudio} disabled={exportingAudio} onClick={exportAudio}><Download size={13} /></Button>}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={showDiagnostics ? "隐藏运行诊断" : "显示运行诊断"}
              aria-expanded={showDiagnostics}
              onClick={() => setShowDiagnostics((value) => !value)}
            >
              <AudioLines size={13} />
            </Button>
            <i
              className={`recording-indicator${recordingActive ? " active" : ""}`}
            />
          </div>
        </div>
        {showDiagnostics && (
          <div className="recording-diagnostics" aria-label="ASR 运行诊断">
            {asrDiagnostics ? (
              <>
                {diagnosticRows.map(([label, value]) => (
                  <span key={label}>
                    {label}
                    <strong>{value}</strong>
                  </span>
                ))}
                <small>最近心跳 {asrDiagnostics.updatedAt}</small>
              </>
            ) : (
              <small>等待下一次心跳诊断…</small>
            )}
          </div>
        )}
        <div className="recording-timer">
          <strong>{elapsedLabel}</strong>
        </div>
        <RecordingWave active={recordingActive} />
        {session && session.status !== "completed" ? (
          <div className="recording-controls">
            <Button
              className="recording-primary-action"
              onClick={startMeeting}
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
                : session.remoteStatus === "paused"
                  ? "继续会议"
                  : "开始会议"}
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
        ) : (
          <p className="recording-controls-note">从会议管理新建会议后开始录音。</p>
        )}
        <div className="microphone-status">
          {recordingActive ? <Mic size={13} /> : <MicOff size={13} />}
          {recordingActive
            ? "麦克风采集中"
            : paused && isRecording
              ? "麦克风已暂停"
              : "麦克风未开启"}
        </div>
      </Card>
    );
  }

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

  if (!authUser) {
    return (
      <div className="desktop-app auth-desktop-shell">
        {renderWindowTitlebar()}
        <main className="loading-screen auth-screen">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="auth-settings-button"
            aria-label="设置服务端地址"
            title="设置服务端地址"
            onClick={() => {
              setConnectionUrl(config.stt.baseUrl);
              setConnectionSettingsError("");
              setConnectionSettingsOpen(true);
            }}
          >
            <Settings />
          </Button>
          <form className="auth-panel" onSubmit={submitAuth}>
            <WorkspaceBrand />
            <div className="auth-tabs"><button type="button" className={authMode === "login" ? "active" : ""} onClick={() => { setAuthMode("login"); setAuthNotice(""); }}>登录</button><button type="button" className={authMode === "register" ? "active" : ""} onClick={() => { setAuthMode("register"); setAuthNotice(""); }}>注册</button></div>
            <Field label={authMode === "register" ? <>账号<i className="required-mark" aria-hidden="true">*</i></> : "账号"}><Input value={authForm.account} onChange={(event) => setAuthForm({ ...authForm, account: event.target.value })} required /></Field>
            <Field label={authMode === "register" ? <>密码<i className="required-mark" aria-hidden="true">*</i></> : "密码"}><Input type="password" value={authForm.password} onChange={(event) => setAuthForm({ ...authForm, password: event.target.value })} minLength={authMode === "register" ? 8 : 0} required={authMode === "register"} /></Field>
            {authMode === "register" && <><Field label={<>部门<i className="required-mark" aria-hidden="true">*</i></>}><Input value={authForm.department} onChange={(event) => setAuthForm({ ...authForm, department: event.target.value })} required /></Field><Field label={<>工号<i className="required-mark" aria-hidden="true">*</i></>}><Input value={authForm.employeeId} onChange={(event) => setAuthForm({ ...authForm, employeeId: event.target.value })} required /></Field></>}
            {authNotice && <p className="auth-success" role="status">{authNotice}</p>}
            {authError && <p className="auth-error" role="alert">{authError}</p>}
            <Button type="submit" disabled={authBusy}>{authBusy ? "处理中…" : authMode === "register" ? "注册" : "登录"}</Button>
          </form>
        </main>
        <Dialog open={connectionSettingsOpen} onOpenChange={setConnectionSettingsOpen}>
          <DialogContent className="connection-settings-dialog">
            <DialogHeader>
              <DialogTitle>服务连接设置</DialogTitle>
              <DialogDescription>配置登录和会议操作使用的 audio2text 服务地址。</DialogDescription>
            </DialogHeader>
            <form className="connection-settings-form" onSubmit={saveConnectionSettings}>
              <Field label="服务端地址">
                <Input
                  type="url"
                  value={connectionUrl}
                  onChange={(event) => setConnectionUrl(event.target.value)}
                  placeholder="http://127.0.0.1:8000"
                  autoFocus
                  required
                />
              </Field>
              {connectionSettingsError && <p className="auth-error" role="alert">{connectionSettingsError}</p>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setConnectionSettingsOpen(false)}>取消</Button>
                <Button type="submit" disabled={connectionSettingsBusy}>
                  {connectionSettingsBusy ? "保存中…" : "保存"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  if (authUser.must_change_password) {
    return (
      <div className="desktop-app auth-desktop-shell">
        {renderWindowTitlebar()}
        <main className="loading-screen auth-screen">
          <form className="auth-panel" onSubmit={submitPasswordSetup}>
            <WorkspaceBrand />
            <h2>首次登录</h2>
            <p className="auth-help">管理员当前使用默认空密码，请设置一个新的登录密码。</p>
            <Field label="新密码"><Input type="password" value={passwordSetup} onChange={(event) => setPasswordSetup(event.target.value)} minLength={8} maxLength={128} required disabled={authBusy} autoFocus /></Field>
            <Field label="确认密码"><Input type="password" value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} minLength={8} maxLength={128} required disabled={authBusy} /></Field>
            {authError && <p className="auth-error" role="alert">{authError}</p>}
            <Button type="submit" disabled={authBusy}>{authBusy ? "保存中…" : "保存新密码"}</Button>
          </form>
        </main>
      </div>
    );
  }

  return (
    <div className="desktop-app">
      {renderWindowTitlebar()}

      <Dialog
        open={Boolean(exportSuccessMessage)}
        onOpenChange={(open) => {
          if (!open) setExportSuccessMessage("");
        }}
      >
        <DialogContent className="export-success-dialog" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>导出成功</DialogTitle>
            <DialogDescription>{exportSuccessMessage}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>

      <CreateMeetingDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        departments={departments}
        minutesFormats={minutesFormats}
        loading={departmentsLoading}
        departmentError={departmentsError}
        uploadProgress={uploadProgress}
        onRefresh={refreshCatalog}
        onCreate={createMeeting}
        initialTitle={""}
        initialLanguage={config.stt.language}
      />
      <Dialog open={minutesExportOpen} onOpenChange={setMinutesExportOpen}>
        <DialogContent className="export-format-dialog">
          <DialogHeader>
            <DialogTitle>选择纪要格式</DialogTitle>
            <DialogDescription>请选择要导出的文件格式。</DialogDescription>
          </DialogHeader>
          <div className="export-format-options">
            <Button type="button" variant="outline" onClick={() => void exportMinutes("markdown")} disabled={exportingMinutes}>
              Markdown（.md）
            </Button>
            <Button type="button" variant="outline" onClick={() => void exportMinutes("docx")} disabled={exportingMinutes}>
              Word 文档（.docx）
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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
        </aside>

        <main className="main-workspace">
          <header className="workspace-topbar">
            <nav className="breadcrumb" aria-label="面包屑">
              <PanelLeft size={15} />
              <span>工作空间</span>
              <ChevronRight size={12} />
              <strong>{currentPage}</strong>
            </nav>
            {slogan && <strong className="workspace-slogan" title={slogan}>{slogan}</strong>}
            <div className="topbar-actions">
              <span className="topbar-date">
                <CalendarDays size={13} />
                {dateLabel}
              </span>
              <button className="topbar-logout" type="button" onClick={logout}>
                <LogOut size={14} />
                <span>退出登录</span>
              </button>
            </div>
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
                  <div className="meeting-title-row">
                    <h1 title={sessionTitle}>{sessionTitle}</h1>
                  </div>
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
                      <p>开启录音，实时记录讨论内容。结束后生成会议纪要。</p>
                    )}
                  </div>
                  {session && (
                    <div
                      className="meeting-processing-status"
                      aria-label="会议处理状态"
                    >
                      {processingStates.map((item) => (
                        <span
                          key={item.key}
                          className={`processing-chip processing-chip--${item.tone}`}
                        >
                          <i />
                          {item.label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="meeting-heading-actions">
                  {renderRecordingControl()}
                  {!session && (
                    <Button
                      variant="outline"
                      className="meeting-create-action"
                      onClick={requestCreate}
                    >
                      <Plus size={15} />
                      新建会议
                    </Button>
                  )}
                </div>
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
                      转写记录
                    </TabsTrigger>
                    <TabsTrigger value="minutes">
                      <Sparkles size={14} />
                      会议纪要
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="transcript" className="meeting-panel">
                    <Card className="document-card">
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
                                : imported ? "正在处理导入音频，转写完成后会在这里显示。" : "开启录音后，每一个想法都会在这里留下痕迹。"
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
                      <button
                        type="button"
                        className="transcript-latest-button"
                        onClick={followTranscript}
                        hidden={transcriptFollowing || !transcripts.length}
                      >
                        回到最新
                        <ChevronRight size={13} />
                      </button>
                      <div className="document-footer">
                        <div className="document-footer-actions">
                          <label className="scroll-toggle">
                            <span>自动滚动</span>
                            <Switch
                              size="sm"
                              checked={autoScroll}
                              onCheckedChange={setAutoScroll}
                              aria-label="自动滚动转写"
                            />
                          </label>
                          <span>
                            {textCount.toLocaleString()} 字
                          </span>
                          {transcripts.length > 0 && meetingApi && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={exportingText}
                              onClick={exportText}
                            >
                              <Download size={14} />
                              {exportingText ? "正在准备…" : "导出转写"}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            disabled={!transcripts.length}
                            onClick={copyTranscript}
                            aria-label="复制转写"
                            title="复制转写"
                          >
                            <Copy size={13} />
                          </Button>
                        </div>
                      </div>
                    </Card>
                  </TabsContent>
                  <TabsContent value="minutes" className="meeting-panel">
                    <Card className="document-card">
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
                            aria-label="会议纪要正文"
                            tabIndex={0}
                          >
                            <MinutesMarkdown text={session.minutes} />
                          </article>
                        ) : (
                          <EmptyDocument
                            icon={summaryBusy ? LoaderCircle : Sparkles}
                            iconClassName={summaryBusy ? "animate-spin" : undefined}
                            title={
                              importPending ? importStatusLabel(importJob) : correcting
                                ? "正在校正说话人"
                                : summaryBusy
                                ? "正在整理会议纪要"
                                : "让会议有清晰的下一步"
                            }
                            description={
                              importPending ? (importJob.status === "failed" ? "请点击音频卡片中的重试处理，已保存的内容会保留。" : "后台处理完成后将自动展示会议纪要。") : correcting
                                ? "校正完成后将生成会议纪要。"
                                : summaryBusy
                                ? "正在提炼核心结论、决策与待办，请稍候。"
                                : "结束会议后，将完整转写整理为核心结论、决策、待办和下一步安排。"
                            }
                          />
                        )}
                      </div>
                      <div className="document-footer">
                        <div className="document-footer-actions">
                          {session && !isRecording && transcripts.length > 0 && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={
                                summaryBusy || importPending ||
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
                              {session.minutes ? "重新生成" : "生成纪要"}
                            </Button>
                          )}
                          {session?.minutes && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="gap-1.5 text-xs"
                                disabled={exportingMinutes}
                                onClick={() => setMinutesExportOpen(true)}
                              >
                                <Download size={14} />
                                {exportingMinutes ? "正在准备…" : "导出纪要"}
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    </Card>
                  </TabsContent>
                </Tabs>

                <div className="meeting-aside">
                  <StageSummaryPanel
                    key={session?.remoteMeetingId || "no-meeting"}
                    summaries={stageSummaries}
                    status={stageSummaryState.status}
                    windowSeconds={stageSummaryState.windowSeconds}
                    formatTime={formatElapsed}
                    error={stageSummaryBubbleError}
                    retrying={retryingStageSummaries}
                    onRetry={retryStageSummaries}
                    onJump={jumpToStageSummary}
                    onExport={exportStageSummaries}
                    exporting={exportingStageSummaries}
                  />
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
          {activeView === "departments" && authUser?.is_admin && (
            <DepartmentManagement
              key={config.stt.baseUrl}
              api={meetingApi}
              departments={departments}
              loading={departmentsLoading}
              error={departmentsError}
              onChanged={refreshCatalog}
            />
          )}
          {activeView === "voiceprints" && authUser?.is_admin && (
            <VoiceprintManagement
              key={config.stt.baseUrl}
              api={meetingApi}
              departments={departments}
            />
          )}
          {activeView === "minutesFormats" && authUser?.is_admin && (
            <MinutesFormatManagement key={config.stt.baseUrl} api={meetingApi} formats={minutesFormats} onChanged={refreshCatalog} />
          )}
        </main>
      </div>
    </div>
  );
}
