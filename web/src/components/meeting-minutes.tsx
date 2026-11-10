import { lazy, memo, Suspense, useEffect, useState } from "react"
import {
  ChevronDown,
  Download,
  FileText,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { api, ApiError, authToken, errorMessage, importStatusLabel, type Meeting } from "@/lib/meetings"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

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
  onConfigure?: () => void
}) {
  const [minutes, setMinutes] = useState<Minutes | null>(null)
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [revision, setRevision] = useState(0)
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
              {minutes && !minutes.available && onConfigure && (
                <Button variant="outline" size="sm" className="mt-4" onClick={onConfigure}>
                  配置模型
                </Button>
              )}
            </div>
          </div>
        )}
      </ScrollArea>
      <div className="transcript-footer minutes-footer">
        <div className="document-footer-actions">
          {ended && hasTranscript && minutes?.available && (
            <Button
              id="generate-minutes"
              variant="ghost"
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
          {minutes?.text && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1.5 text-xs">
                  <Download />
                  导出纪要
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <a id="download-minutes-markdown" href={`/api/meetings/${meeting.id}/minutes/download?format=markdown&token=${encodeURIComponent(authToken())}`}>
                    Markdown（.md）
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a id="download-minutes-docx" href={`/api/meetings/${meeting.id}/minutes/download?format=docx&token=${encodeURIComponent(authToken())}`}>
                    Word 文档（.docx）
                  </a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </Card>
  )
})
