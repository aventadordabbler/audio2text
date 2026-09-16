import { useEffect, useState } from "react";
import { AudioLines, CalendarDays, CheckCheck, FileText } from "lucide-react";
import { Card } from "@/components/ui/card";
import MinutesMarkdown from "@/components/minutes-markdown";
import { EmptyDocument } from "@/components/workspace-ui.jsx";

export function MinutesWindow() {
  const [payload, setPayload] = useState({
    title: "会议总结",
    minutes: "",
    startedAtLabel: "",
    endedAtLabel: "",
  });

  useEffect(() => {
    let disposed = false;
    let unsubscribe = () => {};
    function update(next) {
      if (disposed || !next) return;
      setPayload(next);
      document.title = `${next.title || "会议总结"} - 会议助手`;
    }
    async function bootstrap() {
      update(await window.meetingDesktop.getMinutesPayload());
      if (!disposed)
        unsubscribe = window.meetingDesktop.onMinutesPayload(update);
    }
    bootstrap();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return (
    <main className="minutes-window">
      <header className="minutes-window-topbar">
        <span>
          <AudioLines size={16} />
          会议助手
        </span>
        <span>
          <FileText size={13} />
          会议总结
        </span>
      </header>
      <div className="minutes-window-content">
        <div className="page-heading">
          <div>
            <div className="heading-eyebrow">会议归档 / 总结</div>
            <h1>{payload.title || "会议总结"}</h1>
            <div className="meeting-meta">
              <span>
                <CalendarDays size={13} />
                {[
                  payload.startedAtLabel,
                  payload.endedAtLabel ? `至 ${payload.endedAtLabel}` : "",
                ]
                  .filter(Boolean)
                  .join("  ") || "会议记录"}
              </span>
            </div>
          </div>
        </div>
        <Card className="document-card">
          <div className="document-heading">
            <h2>
              <FileText size={16} />
              会议总结
            </h2>
          </div>
          <div className="document-scroll panel-scroll">
            {payload.minutes ? (
              <article
                className="minutes-document"
                aria-label="会议总结正文"
                tabIndex={0}
              >
                <MinutesMarkdown text={payload.minutes} />
              </article>
            ) : (
              <EmptyDocument
                title="暂无会议总结"
                description="会议结束后，可在工作台生成总结并在这里查看。"
              />
            )}
          </div>
          <div className="document-footer">
            <span>
              <CheckCheck size={13} />
              {payload.minutes ? "会议总结已保存" : "等待生成总结"}
            </span>
            <span>会议助手</span>
          </div>
        </Card>
      </div>
    </main>
  );
}
