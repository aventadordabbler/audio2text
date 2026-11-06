import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const LLM_SETTINGS_FORM_ID = "llm-settings-form";

export function ServerModelSettings({ api, onSaveStateChange }) {
  const [model, setModel] = useState(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const formRef = useRef(null);
  const testController = useRef(null);
  const disabled = busy || testing;
  const canSave = Boolean(api && model && !disabled);
  useEffect(() => {
    onSaveStateChange?.({ canSave, busy });
  }, [canSave, busy, onSaveStateChange]);
  useEffect(() => {
    const controller = new AbortController();
    setModel(null);
    setError("");
    setNotice("");
    setKey("");
    setTesting(false);
    setTestResult(null);
    if (api)
      api
        .modelConfigs({ signal: controller.signal })
        .then((items) => {
          if (!controller.signal.aborted)
            setModel(items.find((item) => item.kind === "llm"));
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(error.message);
        });
    return () => {
      controller.abort();
      testController.current?.abort();
      testController.current = null;
    };
  }, [api]);

  function draftConfig() {
    return {
      base_url: model.base_url.trim(),
      model: model.model.trim(),
      timeout_seconds: Number(model.timeout_seconds),
      ...(key ? { api_key: key } : {}),
    };
  }

  function updateField(field, value) {
    if (field === "api_key") setKey(value);
    else setModel((current) => ({ ...current, [field]: value }));
    setNotice("");
    setError("");
    setTestResult(null);
  }

  async function testConnection() {
    if (
      !canSave ||
      testController.current ||
      !formRef.current?.reportValidity()
    )
      return;
    const controller = new AbortController();
    testController.current = controller;
    setTesting(true);
    setTestResult(null);
    setError("");
    setNotice("");
    try {
      const result = await api.testModelConfig("llm", draftConfig(), {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (result.success) {
        setNotice("连接成功");
        setTestResult(true);
      } else {
        setError("连接失败");
        setTestResult(false);
      }
    } catch {
      if (!controller.signal.aborted) {
        setError("连接失败");
        setTestResult(false);
      }
    } finally {
      if (testController.current === controller) {
        testController.current = null;
        setTesting(false);
      }
    }
  }
  async function save(event) {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError("");
    setNotice("");
    setTestResult(null);
    try {
      const saved = await api.saveModelConfig("llm", draftConfig());
      setModel(saved);
      setKey("");
      setNotice("模型配置已保存到服务端");
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  const statusText =
    error ||
    (!api
      ? "请先保存会议服务地址。"
      : testing
        ? "正在测试模型连接…"
        : busy
          ? "正在保存模型配置…"
          : !model
            ? "正在读取服务端配置…"
            : notice || "修改后点击「保存配置」，会议纪要将使用新配置。");
  return (
    <Card className="settings-card">
      <CardHeader>
        <div className="settings-card-heading">
          <span className="settings-icon">
            <Sparkles size={20} />
          </span>
          <div>
            <CardTitle>大语言模型服务</CardTitle>
            <CardDescription>将会议转写整理为结构化总结。</CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={testConnection}
            disabled={!canSave}
            aria-busy={testing}
            className="model-test-button"
            data-state={testing ? "testing" : testResult === true ? "success" : testResult === false ? "failure" : "idle"}
          >
            {testing && <LoaderCircle size={14} className="animate-spin" />}
            {testing ? "测试中…" : "测试连接"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <form ref={formRef} id={LLM_SETTINGS_FORM_ID} onSubmit={save}>
          {model && (
            <div className="settings-form-grid">
              <Label className="form-field">
                <span>接口地址</span>
                <Input
                  required
                  value={model.base_url}
                  onChange={(event) =>
                    updateField("base_url", event.target.value)
                  }
                  disabled={disabled}
                />
              </Label>
              <Label className="form-field">
                <span>模型名称</span>
                <Input
                  required
                  value={model.model}
                  onChange={(event) => updateField("model", event.target.value)}
                  disabled={disabled}
                />
              </Label>
              <Label className="form-field">
                <span>接口密钥</span>
                <Input
                  type="password"
                  autoComplete="off"
                  value={key}
                  placeholder={
                    model.api_key_configured ? "已配置，留空保留原密钥" : "可选"
                  }
                  onChange={(event) =>
                    updateField("api_key", event.target.value)
                  }
                  disabled={disabled}
                />
              </Label>
              <Label className="form-field">
                <span>请求超时（秒）</span>
                <Input
                  type="number"
                  min={1}
                  max={600}
                  required
                  value={model.timeout_seconds}
                  onChange={(event) =>
                    updateField("timeout_seconds", event.target.value)
                  }
                  disabled={disabled}
                />
              </Label>
            </div>
          )}
          <div
            className={`provider-status ${error ? "error" : notice ? "ok" : ""}`}
            role={error ? "alert" : "status"}
          >
            <i />
            {statusText}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
