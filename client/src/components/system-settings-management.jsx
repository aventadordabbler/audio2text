import { useEffect, useState } from "react";
import { LoaderCircle, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

const fields = [
  { key: "llm_max_tokens", label: "LLM 最大输出 Token", min: 256, hint: "控制会议纪要和长文本压缩的输出上限。" },
  { key: "llm_chunk_chars", label: "长会议分段字符数", min: 1000, hint: "超过此字符数的会议文本会先分段压缩。" },
  { key: "stage_summary_window_seconds", label: "阶段总结窗口（秒）", min: 10, max: 300, hint: "按已定稿录音划分阶段总结窗口。" },
  { key: "stage_summary_max_tokens", label: "阶段总结最大输出 Token", min: 128, max: 8192, hint: "限制单个阶段总结的输出长度。" },
];

export function SystemSettingsManagement({ api, onSaved }) {
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    if (!api) {
      setLoading(false);
      setError("请先配置会议服务地址。");
      return () => controller.abort();
    }
    api.systemSettings({ signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setDraft(result);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api]);

  function update(key, value) {
    setDraft((current) => current ? { ...current, [key]: Number(value) } : current);
    setSaved(false);
    setError("");
  }

  function updateSlogan(value) {
    setDraft((current) => current ? { ...current, slogan: value } : current);
    setSaved(false);
    setError("");
  }

  async function save(event) {
    event.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await api.saveSystemSettings(draft);
      setDraft(result);
      onSaved?.(result);
      setSaved(true);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page-content management-page">
      <div className="page-heading">
        <div>
          <h1>系统管理</h1>
          <p>维护 ASR、会议纪要和阶段总结的运行参数。</p>
        </div>
      </div>
      {!api && <div role="alert" className="management-error">请先配置会议服务地址。</div>}
      <Card className="history-table-card system-settings-card">
        {loading ? (
          <p role="status">正在读取系统设置…</p>
        ) : draft ? (
          <form className="management-form" onSubmit={save}>
            <Label className="form-field system-settings-slogan">
              <span>系统标语</span>
              <Input
                type="text"
                maxLength={200}
                value={draft.slogan}
                onChange={(event) => updateSlogan(event.target.value)}
                disabled={busy}
              />
              <small>显示在 Web 和 Client 顶部。</small>
            </Label>
            <div className="system-settings-grid">
              {fields.map((field) => (
                <Label className="form-field" key={field.key}>
                  <span>{field.label}</span>
                  <Input
                    type="number"
                    min={field.min}
                    max={field.max}
                    step="1"
                    required
                    value={draft[field.key]}
                    onChange={(event) => update(field.key, event.target.value)}
                    disabled={busy}
                  />
                  <small>{field.hint}</small>
                </Label>
              ))}
            </div>
            <label className="system-settings-toggle">
              <span>
                <strong>使用请求级 Qwen Chat Template</strong>
                <small>开启后，ASR 请求携带应用内置模板，服务端需要允许请求级模板。</small>
              </span>
              <Switch
                checked={draft.asr_use_request_chat_template}
                onCheckedChange={(checked) => {
                  setDraft((current) => current ? { ...current, asr_use_request_chat_template: checked } : current);
                  setSaved(false);
                  setError("");
                }}
                disabled={busy}
                aria-label="使用请求级 Qwen Chat Template"
              />
            </label>
            {error && <p role="alert" className="management-error">{error}</p>}
            {saved && <p role="status" className="management-success">系统设置已保存。</p>}
            <div className="heading-actions system-settings-actions">
              <Button type="submit" disabled={busy}>
                {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Save size={14} />}
                保存设置
              </Button>
            </div>
          </form>
        ) : (
          <p role="alert" className="management-error">{error || "系统设置读取失败。"}</p>
        )}
      </Card>
    </section>
  );
}
