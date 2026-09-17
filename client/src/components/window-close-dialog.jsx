import { useEffect, useRef, useState } from "react";
import { Minus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function WindowCloseDialog() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const responding = useRef(false);
  const minimizeButton = useRef(null);
  const previousFocus = useRef(null);

  useEffect(() => window.meetingDesktop?.onCloseRequested?.(() => {
    previousFocus.current = document.activeElement;
    setError("");
    setOpen(true);
  }), []);

  async function respond(action) {
    if (responding.current) return;
    responding.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await window.meetingDesktop.respondCloseWindow(action);
      if (!result?.ok) throw new Error("Window action was rejected");
      setOpen(false);
    } catch {
      setError("操作未完成，请重试。");
    } finally {
      responding.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) void respond("cancel"); }}>
      <DialogContent
        className="window-close-dialog"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          minimizeButton.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (previousFocus.current?.isConnected) previousFocus.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>关闭窗口</DialogTitle>
          <DialogDescription>
            关闭窗口会停止当前录音。你也可以最小化到任务栏，让会议继续。
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="management-error">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => respond("cancel")}>
            取消
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => respond("close")}>
            <X size={14} />
            关闭窗口
          </Button>
          <Button ref={minimizeButton} disabled={busy} onClick={() => respond("minimize")}>
            <Minus size={14} />
            最小化窗口
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
