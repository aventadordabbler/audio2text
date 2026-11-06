import { useEffect, useState, type FormEvent } from "react"
import { ArrowRight, AudioLines, LoaderCircle, Mic, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api, errorMessage, importWav, STT_LANGUAGE_OPTIONS, type Meeting, type MinutesFormat } from "@/lib/meetings"

export function CreateMeetingDialog({
  open,
  onOpenChange,
  onCreated,
  minutesFormats,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (meeting: Meeting) => void
  minutesFormats: MinutesFormat[]
}) {
  const [title, setTitle] = useState("")
  const [source, setSource] = useState("recording")
  const [files, setFiles] = useState<File[]>([])
  const [language, setLanguage] = useState("auto")
  const [minutesFormatId, setMinutesFormatId] = useState("default")
  const [submitting, setSubmitting] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ completed: number; total: number } | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    if (open) {
      setTitle("")
      setSource("recording")
      setFiles([])
      setLanguage("auto")
      setMinutesFormatId(minutesFormats.find((item) => item.is_default)?.id || minutesFormats[0]?.id || "default")
      setUploadProgress(null)
      setError("")
    }
  }, [open])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!title.trim()) {
      setError("请为这场会议起个名字。")
      return
    }
    if (source === "wav" && !files.length) return
    setSubmitting(true)
    setError("")
    try {
      const meeting = source === "wav"
        ? await importWav(files, title.trim(), language, minutesFormatId, (completed, total) => setUploadProgress({ completed, total }))
        : await api<Meeting>("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          language: language === "auto" ? null : language,
          minutes_format_id: minutesFormatId,
        }),
      })
      onCreated(meeting)
      onOpenChange(false)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setSubmitting(false)
      setUploadProgress(null)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!submitting) onOpenChange(value)
      }}
    >
      <DialogContent
        id="create-dialog"
        className="create-dialog max-h-[90vh] gap-0 overflow-y-auto p-0 sm:max-w-[460px]"
      >
        <form id="create-form" onSubmit={submit}>
          <div className="create-dialog-body px-7 pb-7 pt-8">
            <div className="mb-5 flex size-12 items-center justify-center rounded-2xl border border-neutral-100 bg-neutral-50 text-neutral-600">
              <AudioLines className="size-6" />
            </div>
            <DialogHeader className="text-left">
              <DialogTitle className="text-xl font-semibold tracking-tight">
                开始一场新会议
              </DialogTitle>
              <DialogDescription className="mt-2 leading-6">
                设置会议名称与转写语言。
              </DialogDescription>
            </DialogHeader>
            <div className="mt-7 space-y-5">
              <div className="space-y-2.5">
                <Label htmlFor="source-input">创建方式</Label>
                <Select value={source} onValueChange={setSource} disabled={submitting}>
                  <SelectTrigger id="source-input" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent
                    position="popper"
                    side="bottom"
                    align="start"
                    sideOffset={4}
                    avoidCollisions={false}
                    className="meeting-filter-menu"
                  >
                    <SelectItem value="recording">实时录音</SelectItem>
                    <SelectItem value="wav">导入音频（WAV/MP3）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2.5">
                <Label htmlFor="minutes-format-input">纪要格式</Label>
                <Select value={minutesFormatId} onValueChange={setMinutesFormatId} disabled={submitting}>
                  <SelectTrigger id="minutes-format-input" className="h-11 w-full"><SelectValue placeholder="选择纪要格式" /></SelectTrigger>
                  <SelectContent position="popper" side="bottom" align="start" sideOffset={4} avoidCollisions={false} className="meeting-filter-menu">
                    {minutesFormats.map((format) => <SelectItem key={format.id} value={format.id}>{format.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {source === "wav" && <div className="space-y-2.5">
                <Label htmlFor="wav-input">音频文件</Label>
                <Input id="wav-input" type="file" multiple accept=".wav,.mp3,audio/wav,audio/x-wav,audio/mpeg" required disabled={submitting}
                  onChange={(event) => {
                    const selected = Array.from(event.target.files || [])
                    setFiles(selected)
                    if (selected[0] && !title.trim()) setTitle(selected[0].name.replace(/\.(wav|mp3)$/i, "").slice(0, 80))
                  }} />
              </div>}

              <div className="space-y-2.5">
                <Label htmlFor="title-input">
                  会议名称 <span className="text-muted-foreground">*</span>
                </Label>
                <Input
                  id="title-input"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="例如：产品设计周会"
                  maxLength={80}
                  required
                  disabled={submitting}
                  className="h-11"
                />
              </div>
              <div className="space-y-2.5">
                <Label htmlFor="language-input">转写语言</Label>
                <Select value={language} onValueChange={setLanguage} disabled={submitting}>
                  <SelectTrigger id="language-input" className="h-11 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    side="bottom"
                    align="start"
                    sideOffset={4}
                    avoidCollisions={false}
                    className="meeting-filter-menu"
                  >
                    {STT_LANGUAGE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.value === "auto" && <Sparkles className="size-3.5 text-neutral-500" />}
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs leading-5 text-muted-foreground">
                  指定语言可以帮助模型更准确地理解对话。
                </p>
              </div>
            </div>
            {error && (
              <p id="create-error" role="alert" className="mt-4 text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="mt-6 flex items-start gap-2.5 rounded-lg bg-muted/60 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
              <Mic className="mt-0.5 size-3.5 shrink-0" />
              <p>{source === "wav" ? "上传后自动转写、标注说话人并生成纪要，时长按音频计算。上传完成后可离开页面。" : "创建后进入会议，点击「开始录音」才会开启麦克风。"}</p>
            </div>
          </div>
          <DialogFooter className="m-0 border-t bg-muted/30 px-7 py-5 sm:justify-between">
            <Button
              id="cancel-create"
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              取消
            </Button>
            <Button id="submit-create" type="submit" disabled={submitting || (source === "wav" && !files.length)} className="gap-2 px-5">
              {submitting ? <LoaderCircle className="size-4 animate-spin" /> : null}{source === "wav" ? (submitting ? (uploadProgress ? `正在上传分片 ${uploadProgress.completed}/${uploadProgress.total}` : "正在上传并解析") : "上传并创建") : "创建并进入"}
              <ArrowRight className="size-4" />
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
