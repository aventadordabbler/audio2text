import { useEffect, useRef, useState, type FormEvent } from "react"
import { Check, CircleCheck, CircleX, LoaderCircle, PlugZap, Save, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
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
  asr_mode: "qwen_streaming" | "transcription"
  api_key_configured: boolean
  configured: boolean
  updated_at: string | null
}

interface ConnectionResult {
  success: boolean
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
  const [mode, setMode] = useState(config.asr_mode)
  const [key, setKey] = useState("")
  const [clearKey, setClearKey] = useState(false)
  const [timeout, setTimeout] = useState(String(config.timeout_seconds))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionResult | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const testController = useRef<AbortController | null>(null)
  const disabled = busy || testing
  const prefix = `model-${config.kind}`
  const testState = testing ? "testing" : testResult ? (testResult.success ? "success" : "failure") : "idle"
  const testStatus = testing ? "测试中…" : testResult ? (testResult.success ? "连接成功" : "连接失败") : ""

  useEffect(() => () => {
    testController.current?.abort()
    testController.current = null
  }, [])

  function payload() {
    return JSON.stringify({
      base_url: url.trim(),
      model: model.trim(),
      timeout_seconds: Number(timeout),
      api_key: clearKey ? "" : key || undefined,
      ...(config.kind === "asr" ? { asr_mode: mode } : {}),
    })
  }

  async function testConnection() {
    if (disabled || testController.current || !formRef.current?.reportValidity()) return
    const controller = new AbortController()
    testController.current = controller
    setTesting(true)
    setTestResult(null)
    setError("")
    try {
      const result = await api<ConnectionResult>(`/api/model-configs/${config.kind}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload(),
        signal: controller.signal,
      })
      if (!controller.signal.aborted) setTestResult(result)
    } catch {
      if (!controller.signal.aborted) setTestResult({ success: false })
    } finally {
      if (testController.current === controller) {
        testController.current = null
        setTesting(false)
      }
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (disabled) return
    setBusy(true)
    setError("")
    setSaved(false)
    try {
      const result = await api<ModelConfig>(`/api/model-configs/${config.kind}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: payload(),
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
    <form ref={formRef} onSubmit={save} onChange={() => { setSaved(false); setTestResult(null) }}>
      <div className="model-config-fields create-dialog-body">
        {config.kind === "llm" && (
          <p className="model-config-hint">用于整理会议纪要，需要支持 OpenAI 兼容的对话接口。</p>
        )}
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-url`}>API 地址</Label>
          <Input
            id={`${prefix}-url`}
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://your-model-server/v1"
            required
            disabled={disabled}
            maxLength={2000}
          />
          <p className="model-field-help">填写应用后端能访问的 API 基础地址，通常以 /v1 结尾。</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-name`}>模型名称</Label>
          <Input
            id={`${prefix}-name`}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={config.kind === "asr" ? "qwen3-asr-1.7b" : "服务提供的模型 ID"}
            required
            disabled={disabled}
            maxLength={200}
          />
        </div>
        {config.kind === "asr" && (
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-mode`}>识别方式</Label>
            <select id={`${prefix}-mode`} value={mode} disabled={disabled}
              onChange={(event) => setMode(event.target.value as ModelConfig["asr_mode"])}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="qwen_streaming">Qwen 前缀续写</option>
              <option value="transcription">文件转写（兼容模式）</option>
            </select>
            <p className="model-field-help">{mode === "qwen_streaming"
              ? "需要模型服务支持音频对话和 assistant 前缀续写，可修订当前发言的末尾文字。"
              : "使用标准音频转写接口，分段刷新当前发言；无需服务支持前缀续写。"}</p>
          </div>
        )}
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
            disabled={disabled || clearKey}
            maxLength={4096}
          />
          {config.api_key_configured && (
            <label className="model-key-reset">
              <input
                type="checkbox"
                checked={clearKey}
                disabled={disabled}
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
            disabled={disabled}
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
      <DialogFooter className="model-config-footer m-0 shrink-0 px-6 py-4">
        <span className="sr-only" role="status" aria-live="polite">{testStatus}</span>
        <div className="model-config-actions">
          <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
            关闭
          </Button>
          <div>
            <Button type="button" variant="outline" disabled={disabled} onClick={testConnection} id={`${prefix}-test`}
              className="model-test-button" data-state={testState} aria-busy={testing}
              aria-label={testStatus ? `测试连通性：${testStatus}` : "测试连通性"}
              title={testResult ? `${testStatus}，点击重新测试` : undefined}>
              {testing ? <LoaderCircle className="animate-spin" /> : testResult ? (testResult.success ? <CircleCheck /> : <CircleX />) : <PlugZap />}
              {testing ? "测试中…" : "测试连通性"}
            </Button>
            <Button type="submit" disabled={disabled} className="gap-2" id={`${prefix}-save`}>
              {busy ? <LoaderCircle className="animate-spin" /> : <Save />}保存配置
            </Button>
          </div>
        </div>
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
        aria-describedby={undefined}
        className="create-dialog model-config-dialog gap-0 overflow-hidden p-0 sm:max-w-[520px]"
      >
        <DialogHeader className="shrink-0 px-6 pb-4 pt-6 text-left">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Settings2 className="size-5" />
            模型配置
          </DialogTitle>
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
