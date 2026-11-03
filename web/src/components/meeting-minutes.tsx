import { lazy, memo, Suspense, useEffect, useRef, useState } from "react"
import {
  Check,
  CheckCheck,
  Copy,
  Download,
  FileText,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { api, ApiError, authToken, errorMessage, formatDate, importStatusLabel, type Meeting } from "@/lib/meetings"

const MinutesMarkdown = lazy(() => import("./minutes-markdown"))

function minutesErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 404 && error.message === "Not Found") {
    return "当前后端未提供会议纪要接口，请更新并重启后端服务后刷新状态。"
  }
  return errorMessage(error)
}

interface Minutes {
  meeting_id: string
  status: "not_started" | "generating" | "ready" | "failed"
  text: string
  file_path: string | null
  updated_at: string | null
  error: string
  available: boolean
  stale: boolean
}

export const MeetingMinutes = memo(function MeetingMinutes({
  meeting,
  modelsVersion,
  onConfigure,
}: {
  meeting: Meeting
  modelsVersion: number
  onConfigure: () => void
}) {
  const [minutes, setMinutes] = useState<Minutes | null>(null)
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [revision, setRevision] = useState(0)
  const [copied, setCopied] = useState(false)
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generating = submitting || minutes?.status === "generating"
  const ended = meeting.status === "ended"
  const hasTranscript = !!meeting.text.trim()
  const importPending = !!meeting.import_job && meeting.import_job.status !== "ready"
  const correcting = ["queued", "running"].includes(meeting.processing?.status)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function load() {
      try {
        const result = await api<Minutes>(`/api/meetings/${meeting.id}/minutes`, {
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        setMinutes(result)
        setError("")
        if (meeting.source === "wav" && result.status === "generating") timer = setTimeout(() => void load(), 1500)
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(minutesErrorMessage(error))
          if (meeting.source === "wav") timer = setTimeout(() => void load(), 3000)
        }
      }
    }
    void load()
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [meeting.id, meeting.source, meeting.status, meeting.minutes_version, meeting.processing?.status, revision, modelsVersion])

  useEffect(
    () => () => {
      if (copyTimeout.current) clearTimeout(copyTimeout.current)
    },
    [],
  )

  async function generate() {
    if (generating || correcting || importPending) return
    setSubmitting(true)
    setError("")
    try {
      const result = await api<Minutes>(`/api/meetings/${meeting.id}/minutes`, { method: "POST" })
      setMinutes(result)
      setRevision((value) => value + 1)
    } catch (error) {
      setError(minutesErrorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(minutes!.text)
      setCopied(true)
      if (copyTimeout.current) clearTimeout(copyTimeout.current)
      copyTimeout.current = setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      setError(`复制失败，请使用下载纪要：${errorMessage(error)}`)
    }
  }

  const hint = importPending ? (meeting.import_job?.status === "failed" ? "导入处理失败，请点击音频卡片中的重试处理。" : `${importStatusLabel(meeting.import_job)}，完成后将自动展示纪要。`) : correcting
    ? "正在校正说话人，完成后将自动整理纪要。"
    : generating
    ? "正在整理核心结论、决策与待办，离开页面后仍会继续生成。"
    : !ended
      ? "结束会议后，将根据完整转写自动整理会议纪要。"
      : !hasTranscript
        ? "本次会议没有转写内容，无法生成纪要。"
        : minutes && !minutes.available
          ? "请先在模型配置中添加大语言模型，即可生成会议纪要。"
          : minutes?.status === "failed"
            ? "生成未完成，可以重试。已有转写内容已保存。"
            : "将会议内容整理为结论、决策、待办、风险和下一步安排。"
  const failure = error || minutes?.error

  return (
    <Card className="minutes-card gap-0 rounded-xl py-0 shadow-none" aria-busy={generating}>
      <div className="transcript-heading minutes-heading">
        <div>
          <Sparkles className="size-4 text-muted-foreground" />
          <h2>会议纪要</h2>
        </div>
        {ended && hasTranscript && minutes?.available && (
          <Button
            id="generate-minutes"
            variant="outline"
            size="sm"
            disabled={generating || correcting || importPending}
            onClick={generate}
            className="gap-1.5 text-xs"
          >
            {generating ? (
              <LoaderCircle className="animate-spin" />
            ) : minutes.text ? (
              <RefreshCw />
            ) : (
              <Sparkles />
            )}
            {importPending ? "等待导入完成" : correcting ? "等待校正" : generating
              ? "生成中"
              : minutes.status === "failed"
                ? "重试生成"
                : minutes.text
                  ? "重新生成"
                  : "生成纪要"}
          </Button>
        )}
      </div>
      <ScrollArea className="minutes-scroll">
        {minutes?.stale && <p className="minutes-message" role="status">转写已更新，可重新生成纪要。</p>}
        {failure && (
          <div className="minutes-message" role="alert">
            <p>{failure}</p>
            {error && (
              <Button size="sm" variant="ghost" onClick={() => setRevision((value) => value + 1)}>
                刷新状态
              </Button>
            )}
          </div>
        )}
        {generating && minutes?.text && (
          <p className="minutes-message" role="status">
            正在重新生成，以下保留上次保存的纪要。
          </p>
        )}
        {minutes?.text ? (
          <article
            id="minutes-text"
            className="minutes-text"
            aria-label="会议纪要正文"
            tabIndex={0}
          >
            <Suspense fallback={<p className="text-muted-foreground">正在显示纪要…</p>}>
              <MinutesMarkdown text={minutes.text} />
            </Suspense>
          </article>
        ) : (
          <div className="minutes-empty">
            <div className="document-empty">
              <div className="document-empty-icon">
                {generating || (!minutes && !error) ? (
                  <LoaderCircle className="size-6 animate-spin" />
                ) : (
                  <FileText className="size-6" />
                )}
              </div>
              <h3>
                {generating
                  ? "正在生成会议纪要"
                  : !minutes && !error
                    ? "正在读取会议纪要"
                    : "让会议有清晰的下一步"}
              </h3>
              <p>{hint}</p>
              {minutes && !minutes.available && (
                <Button variant="outline" size="sm" className="mt-4" onClick={onConfigure}>
                  配置模型
                </Button>
              )}
            </div>
          </div>
        )}
      </ScrollArea>
      <div className="transcript-footer minutes-footer">
        <span id="minutes-status" role="status">
          {generating ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
          ) : minutes?.text ? (
            <CheckCheck className="size-3.5 shrink-0" />
          ) : null}
          {importPending ? importStatusLabel(meeting.import_job) : correcting ? "等待说话人校正" : generating
            ? "后台生成中"
            : minutes?.status === "failed"
              ? "生成失败，可重试"
              : minutes?.text
                ? "纪要已保存"
                : "等待生成纪要"}
          {minutes?.status === "ready" && minutes.updated_at && (
            <time className="minutes-updated" dateTime={minutes.updated_at}>
              {formatDate(minutes.updated_at)}
            </time>
          )}
        </span>
        {minutes?.text && (
          <div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={copy}
              aria-label={copied ? "纪要已复制" : "复制会议纪要"}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
            <Button variant="ghost" size="sm" asChild className="gap-1.5 text-xs">
              <a id="download-minutes" href={`/api/meetings/${meeting.id}/minutes/download?token=${encodeURIComponent(authToken())}`}>
                <Download />
                下载纪要
              </a>
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
})
