import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import {
  ArrowDown,
  ArrowLeft,
  AudioLines,
  CalendarDays,
  Check,
  CheckCheck,
  Clock3,
  Copy,
  Download,
  FileText,
  Languages,
  LoaderCircle,
  Mic,
  MicOff,
  Pause,
  Play,
  Square,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { MeetingMinutes } from "./meeting-minutes"
import { MeetingStatusBadge } from "./meeting-status"
import { errorMessage, formatDate, formatDuration, languageLabels } from "@/lib/meetings"
import { RecordingSession } from "@/lib/recording-session"
import { downloadRecording } from "@/lib/recording-download"

export function MeetingDetail({
  session,
  onError,
  modelsVersion,
  onConfigure,
}: {
  session: RecordingSession
  onError: (error: string) => void
  modelsVersion: number
  onConfigure: () => void
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const meeting = state.meeting!
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState(false)
  const [exportingAudio, setExportingAudio] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [activeTab, setActiveTab] = useState(meeting.status === "ended" ? "minutes" : "transcript")
  const previousStatus = useRef(meeting.status)
  const scrollRoot = useRef<HTMLDivElement>(null)
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const following = useRef(true)
  const { status } = meeting
  const recording = status === "recording" && state.localRecording && !state.finishing
  const followLiveText = autoScroll && state.liveVersion > 0
  const textLength = Array.from(meeting.text).length
  const seconds =
    meeting.duration_seconds +
    (status === "recording" ? Math.max(0, now - state.durationUpdatedAt) / 1000 : 0)

  useEffect(() => {
    if (status === "ended" && previousStatus.current !== "ended") setActiveTab("minutes")
    previousStatus.current = status
  }, [status])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => {
      clearInterval(timer)
      if (copyTimeout.current) clearTimeout(copyTimeout.current)
    }
  }, [])

  function scrollToBottom() {
    const viewport = scrollRoot.current?.querySelector("[data-slot='scroll-area-viewport']")
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }

  useEffect(() => {
    if (!autoScroll || !following.current || state.liveVersion === 0) return
    const frame = requestAnimationFrame(scrollToBottom)
    return () => cancelAnimationFrame(frame)
  }, [meeting.text, state.partialText, state.liveVersion, autoScroll])

  useEffect(() => {
    const viewport = scrollRoot.current?.querySelector("[data-slot='scroll-area-viewport']")
    if (!viewport) return
    const track = () => { following.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 80 }
    viewport.addEventListener("scroll", track, { passive: true })
    const observer = new ResizeObserver(() => { if (autoScroll && following.current && followLiveText) scrollToBottom() })
    observer.observe(viewport)
    return () => { observer.disconnect(); viewport.removeEventListener("scroll", track) }
  }, [followLiveText, autoScroll])

  async function copyText() {
    try {
      await navigator.clipboard.writeText(meeting.text)
      setCopied(true)
      if (copyTimeout.current) clearTimeout(copyTimeout.current)
      copyTimeout.current = setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      onError(`复制失败，请使用下载文本：${errorMessage(error)}`)
    }
  }

  async function exportAudio() {
    if (exportingAudio) return
    setExportingAudio(true)
    try {
      await downloadRecording(meeting.id)
    } catch (error) {
      onError(`导出录音失败：${errorMessage(error)}`)
    } finally {
      setExportingAudio(false)
    }
  }

  const hints = {
    created: "准备好后，开启麦克风。转写内容会实时显示。",
    recording: state.localRecording
      ? "安心交流，会议内容正在被记录。"
      : "会议正在其他页面录音，关闭该页面后可重新进入继续。",
    paused: "麦克风已暂停。继续录音后，将接着记录这场会议。",
    ended: "会议已结束，已保存的内容可以随时回看。",
  }

  return (
    <Tabs
      id="meeting-view"
      value={activeTab}
      onValueChange={setActiveTab}
      className="page-content detail-page gap-0 animate-page-in"
    >
      <Button
        id="back-button"
        variant="ghost"
        size="sm"
        disabled={state.busy}
        className="back-link -ml-2 mb-5 text-muted-foreground"
        asChild
      >
        <a
          href="#"
          onClick={(event) => {
            if (state.busy) event.preventDefault()
          }}
        >
          <ArrowLeft />
          返回会议列表
        </a>
      </Button>
      <div className="detail-heading">
        <div className="min-w-0">
          <div className="detail-status mb-3">
            <MeetingStatusBadge id="meeting-status" status={status} />
          </div>
          <div className="detail-title-row">
            <h1 id="meeting-title" title={meeting.title}>
              {meeting.title}
            </h1>
            <div id="meeting-meta" className="meeting-meta">
              <span>
                <CalendarDays />
                {formatDate(meeting.created_at)}
              </span>
              <i />
              <span>
                <Languages />
                {languageLabels[meeting.language || ""] || meeting.language || "自动识别语言"}
              </span>
            </div>
          </div>
        </div>
        <div className="detail-toolbar">
          <TabsList className="meeting-tabs">
            <TabsTrigger value="transcript">实时转写</TabsTrigger>
            <TabsTrigger value="minutes">会议纪要</TabsTrigger>
          </TabsList>
          {meeting.text && (
            <Button variant="outline" className="download-heading shrink-0 gap-2 bg-white" asChild>
              <a id="download-link" href={`/api/meetings/${meeting.id}/download`}>
                <Download className="size-4" />
                下载文本
              </a>
            </Button>
          )}
          {meeting.audio_available && (
            <Button variant="outline" className="download-heading shrink-0 gap-2 bg-white"
              id="audio-download-button" disabled={exportingAudio} onClick={exportAudio}>
              <Download className="size-4" />
              {exportingAudio ? "正在准备…" : "导出录音（WAV）"}
            </Button>
          )}
        </div>
      </div>

      <div className="meeting-workspace">
        <div className="meeting-content">
          <TabsContent value="transcript" forceMount className="meeting-panel">
            <Card className="transcript-card gap-0 overflow-hidden rounded-xl py-0 shadow-none">
              <div className="transcript-heading">
                <div>
                  <FileText className="size-4.5 text-muted-foreground" />
                  <h2>转写记录</h2>
                  {recording && (
                    <span className="live-label">
                      <span />
                      实时
                    </span>
                  )}
                </div>
                <div className="scroll-toggle">
                  <Label
                    htmlFor="auto-scroll"
                    className="text-xs font-normal text-muted-foreground"
                  >
                    自动滚动
                  </Label>
                  <Switch
                    id="auto-scroll"
                    checked={autoScroll}
                    onCheckedChange={(checked) => {
                      setAutoScroll(checked)
                      if (checked) following.current = true
                      if (checked) requestAnimationFrame(scrollToBottom)
                    }}
                    size="sm"
                  />
                </div>
              </div>
              <ScrollArea ref={scrollRoot} className="transcript-scroll">
                <article
                  id="transcript"
                  className={meeting.text || state.partialText ? "transcript-text" : "transcript-empty"}
                  aria-label="会议转写文本"
                  tabIndex={0}
                >
                  {meeting.text || state.partialText ? (
                    <>
                      {meeting.segments?.length ? meeting.segments.map((segment) => (
                        <section className="transcript-segment" key={segment.segment_id} data-segment-id={segment.segment_id}>
                          <div className="transcript-segment-meta">
                            <span>{segment.speaker_status === "overlap" ? "多人同时讲话" : segment.speaker_status === "multiple" ? "多位说话人" : ["unknown", "pending"].includes(segment.speaker_status) ? "说话人待确认" : segment.speaker_ids.map((id) => meeting.speakers[id]?.name || "未知说话人").join("、") || "说话人待确认"}</span>
                            <time>{formatDuration(segment.start_ms / 1000)}</time>
                          </div>
                          <p>{segment.text}</p>
                        </section>
                      )) : meeting.text}
                      <span className="text-muted-foreground transcript-partial" aria-label="正在识别">{state.partialText}</span>
                    </>
                  ) : (
                    <div className="document-empty">
                      <div className="document-empty-icon">
                        <AudioLines className="size-7" />
                      </div>
                      <h3>
                        {status === "ended"
                          ? "这场会议暂无转写内容"
                          : recording
                            ? "正在聆听你的声音"
                            : status === "paused"
                              ? "稍作停留，随时继续"
                              : "让讨论自然发生"}
                      </h3>
                      <p>
                        {status === "ended"
                          ? "录音期间未检测到语音内容。"
                          : recording
                            ? "说点什么，文字会在这里慢慢展开。"
                            : "开启录音后，每一个想法都会在这里留下痕迹。"}
                      </p>
                      <div className="empty-document-lines" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </div>
                    </div>
                  )}
                </article>
              </ScrollArea>
              <div className="transcript-footer">
                <span id="transcript-state">
                  <span className={recording ? "saving-dot" : "saved-check"}>
                    {recording ? <span /> : <CheckCheck className="size-3.5" />}
                  </span>
                  {state.notice}
                  {meeting.processing?.status === "unavailable" && <span title={meeting.processing.error}> · 说话人识别未就绪</span>}
                  {["queued", "running"].includes(meeting.processing?.status) && <span> · 正在校正说话人</span>}
                  {meeting.processing?.status === "failed" && <span title={meeting.processing.error}> · 说话人校正未完成</span>}
                  {meeting.processing?.status === "pending" && <span> · 说话人标注中</span>}
                </span>
                <div>
                  {status === "ended" && ["failed", "unavailable"].includes(meeting.processing?.status) && (
                    <Button variant="ghost" size="sm" disabled={state.busy} onClick={() => void session.retryDiarization()}>重试说话人校正</Button>
                  )}
                  <span id="text-count">{textLength.toLocaleString()} 字</span>
                  {meeting.text && (
                    <>
                      <Separator orientation="vertical" className="h-3!" />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={copyText}
                            aria-label={copied ? "已复制" : "复制全部文本"}
                          >
                            {copied ? <Check className="text-neutral-600" /> : <Copy />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{copied ? "已复制" : "复制全部文本"}</TooltipContent>
                      </Tooltip>
                    </>
                  )}
                </div>
              </div>
            </Card>
          </TabsContent>
          <TabsContent value="minutes" forceMount className="meeting-panel">
            <MeetingMinutes
              meeting={meeting}
              modelsVersion={modelsVersion}
              onConfigure={onConfigure}
            />
          </TabsContent>
        </div>

        <aside className="meeting-aside">
          <Card className="recording-card gap-0 rounded-xl p-5 shadow-none">
            <div className="recording-card-heading">
              <h2>
                <Mic className="size-4" />
                录音控制
              </h2>
              <span className={recording ? "recording-indicator active" : "recording-indicator"} />
            </div>
            <div className="recording-timer">
              <span id="recording-time">{formatDuration(seconds)}</span>
              <p>累计录音时长</p>
            </div>
            <div className={`audio-wave ${recording ? "active" : ""}`} aria-hidden="true">
              {Array.from({ length: 27 }, (_, i) => (
                <i
                  key={i}
                  style={{
                    height: `${[12, 20, 32, 18, 42, 27, 48, 30, 38][i % 9]}px`,
                    animationDelay: `${i * -0.09}s`,
                  }}
                />
              ))}
            </div>
            <div className="recording-controls">
              {status === "created" && (
                <Button
                  id="start-button"
                  onClick={() => session.run("start")}
                  disabled={state.busy || state.finishing}
                  className="h-10 w-full gap-2"
                >
                  {state.busy ? <LoaderCircle className="animate-spin" /> : <Mic />}开始录音
                </Button>
              )}
              {status === "recording" && (
                <Button
                  id="pause-button"
                  variant="secondary"
                  onClick={() => session.run("pause")}
                  disabled={state.busy || state.finishing || !state.localRecording}
                  className="h-10 w-full gap-2"
                >
                  {state.busy ? <LoaderCircle className="animate-spin" /> : <Pause />}暂停录音
                </Button>
              )}
              {status === "paused" && (
                <Button
                  id="resume-button"
                  onClick={() => session.run("resume")}
                  disabled={state.busy || state.finishing}
                  className="h-10 w-full gap-2"
                >
                  {state.busy ? <LoaderCircle className="animate-spin" /> : <Play />}继续录音
                </Button>
              )}
              {status !== "ended" ? (
                <Button
                  id="end-button"
                  variant="outline"
                  onClick={() => session.run("end")}
                  disabled={
                    state.busy ||
                    (status === "recording" && !state.localRecording && !state.finishing)
                  }
                  className="h-10 w-full gap-2 border-neutral-200 bg-white text-muted-foreground hover:border-neutral-200 hover:bg-neutral-50 hover:text-neutral-600"
                >
                  <Square className="size-3.5" />
                  {state.finishing ? "重试结束会议" : "结束会议"}
                </Button>
              ) : (
                <div className="ended-note">
                  <CheckCheck />
                  会议已结束
                </div>
              )}
            </div>
            <p id="recording-hint" className="recording-hint">
              {state.finishing ? "录音已停止，请重试结束会议，保存最后一段内容。" : hints[status]}
            </p>
            <div id="connection-status" className="microphone-status" role="status">
              {recording ? <Mic /> : status === "ended" ? <Check /> : <MicOff />}
              {state.busy
                ? "正在处理，请稍候…"
                : recording
                  ? "麦克风已开启"
                  : status === "ended"
                    ? "内容已自动保存"
                    : status === "paused"
                      ? "麦克风已暂停"
                      : "麦克风尚未开启"}
            </div>
          </Card>
          <Card className="meeting-info gap-4 rounded-xl p-5 shadow-none">
            <h2>会议信息</h2>
            <dl>
              <div>
                <dt>创建日期</dt>
                <dd>{formatDate(meeting.created_at, false)}</dd>
              </div>
              <div>
                <dt>所属部门</dt>
                <dd className="max-w-36 break-words">{meeting.department_name || "未分类"}</dd>
              </div>
              <div>
                <dt>转写语言</dt>
                <dd>{languageLabels[meeting.language || ""] || meeting.language || "自动识别"}</dd>
              </div>
              <div>
                <dt>记录字数</dt>
                <dd>{textLength.toLocaleString()} 字</dd>
              </div>
              <div>
                <dt>保存方式</dt>
                <dd className="inline-flex items-center gap-1">
                  <Check className="size-3 text-neutral-600" />
                  自动保存
                </dd>
              </div>
            </dl>
          </Card>
          <p className="aside-note">
            <Clock3 className="size-3.5 shrink-0" />
            暂停时不会录音，继续后保留已有内容。
          </p>
        </aside>
      </div>
      <div className="detail-bottom-note">
        <ArrowDown className="size-3.5" />
        {activeTab === "minutes"
          ? "纪要根据转写内容整理，重要结论请结合原文确认。"
          : autoScroll
            ? "开启自动滚动，始终跟上对话的节奏。"
            : "自动滚动已关闭，可以自由回看之前的内容。"}
      </div>
    </Tabs>
  )
}
