import { useEffect, useState, type FormEvent } from "react"
import { Check, LoaderCircle, Save, Settings2 } from "lucide-react"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, errorMessage } from "@/lib/meetings"

interface ModelConfig {
  kind: "asr" | "llm"
  base_url: string
  model: string
  timeout_seconds: number
  api_key_configured: boolean
  configured: boolean
  updated_at: string | null
}

function ModelForm({
  config,
  onSaved,
  onClose,
}: {
  config: ModelConfig
  onSaved: (config: ModelConfig) => void
  onClose: () => void
}) {
  const [url, setUrl] = useState(config.base_url)
  const [model, setModel] = useState(config.model)
  const [key, setKey] = useState("")
  const [clearKey, setClearKey] = useState(false)
  const [timeout, setTimeout] = useState(String(config.timeout_seconds))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)
  const prefix = `model-${config.kind}`

  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError("")
    setSaved(false)
    try {
      const result = await api<ModelConfig>(`/api/model-configs/${config.kind}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_url: url.trim(),
          model: model.trim(),
          timeout_seconds: Number(timeout),
          api_key: clearKey ? "" : key || undefined,
        }),
      })
      setKey("")
      setClearKey(false)
      setSaved(true)
      onSaved(result)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} onChange={() => setSaved(false)}>
      <div className="model-config-fields create-dialog-body">
        <p className="model-config-hint">
          {config.kind === "asr"
            ? "用于会议音频转写，需要支持 OpenAI 兼容的音频转写接口。"
            : "用于整理会议纪要，需要支持 OpenAI 兼容的对话接口。"}
        </p>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-url`}>API 地址</Label>
          <Input
            id={`${prefix}-url`}
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="http://localhost:8001/v1"
            required
            disabled={busy}
            maxLength={2000}
          />
          <p className="model-field-help">填写 API 基础地址，通常以 /v1 结尾。</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-name`}>模型名称</Label>
          <Input
            id={`${prefix}-name`}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={config.kind === "asr" ? "qwen3-asr-1.7b" : "服务提供的模型 ID"}
            required
            disabled={busy}
            maxLength={200}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-key`}>
            API Key <span className="text-muted-foreground">（可选）</span>
          </Label>
          <Input
            id={`${prefix}-key`}
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            autoComplete="new-password"
            placeholder={
              config.api_key_configured ? "已保存密钥，留空保留" : "无鉴权的本地服务可留空"
            }
            disabled={busy || clearKey}
            maxLength={4096}
          />
          {config.api_key_configured && (
            <label className="model-key-reset">
              <input
                type="checkbox"
                checked={clearKey}
                disabled={busy}
                onChange={(event) => setClearKey(event.target.checked)}
              />
              清除已保存的密钥
            </label>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-timeout`}>请求超时（秒）</Label>
          <Input
            id={`${prefix}-timeout`}
            type="number"
            min="1"
            max="600"
            step="1"
            value={timeout}
            onChange={(event) => setTimeout(event.target.value)}
            required
            disabled={busy}
          />
        </div>
        <p className="model-field-help">
          保存后用于新开始的录音或纪要任务；正在进行的任务沿用原配置。
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {saved && (
          <p role="status" className="model-saved">
            <Check className="size-4" />
            配置已保存
          </p>
        )}
      </div>
      <DialogFooter className="m-0 shrink-0 px-6 py-4 sm:justify-between">
        <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
          关闭
        </Button>
        <Button type="submit" disabled={busy} className="gap-2" id={`${prefix}-save`}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Save />}保存配置
        </Button>
      </DialogFooter>
    </form>
  )
}

export function ModelConfigDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [configs, setConfigs] = useState<ModelConfig[]>([])
  const [error, setError] = useState("")
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setConfigs([])
    setError("")
    api<ModelConfig[]>("/api/model-configs", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setConfigs(result)
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error))
      })
    return () => controller.abort()
  }, [open, revision])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        id="model-config-dialog"
        className="create-dialog model-config-dialog gap-0 overflow-hidden p-0 sm:max-w-[520px]"
      >
        <DialogHeader className="shrink-0 px-6 pb-4 pt-6 text-left">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Settings2 className="size-5" />
            模型配置
          </DialogTitle>
          <DialogDescription>分别设置语音识别和会议纪要使用的模型。</DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="p-6">
            <p role="alert">{error}</p>
            <Button onClick={() => setRevision((value) => value + 1)}>重新加载</Button>
          </div>
        ) : !configs.length ? (
          <p role="status" className="p-6 text-sm text-muted-foreground">
            正在读取配置…
          </p>
        ) : (
          <Tabs defaultValue="asr" className="model-config-tabs">
            <TabsList className="mx-6 shrink-0">
              <TabsTrigger value="asr" className="px-4">
                ASR 模型
              </TabsTrigger>
              <TabsTrigger value="llm" className="px-4">
                大语言模型
              </TabsTrigger>
            </TabsList>
            {configs.map((config) => (
              <TabsContent key={config.kind} value={config.kind} className="model-config-panel">
                <ModelForm
                  config={config}
                  onClose={() => onOpenChange(false)}
                  onSaved={(saved) => {
                    setConfigs((values) =>
                      values.map((value) => (value.kind === saved.kind ? saved : value)),
                    )
                    onSaved()
                  }}
                />
              </TabsContent>
            ))}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}
