import { useState } from "react";
import { ArrowUpRight, FileText, LoaderCircle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { summaryExcerpt } from "@/services/stage-summary-bubbles.js";

const STATUS_LABELS = {
  live: "实时更新",
  connecting: "连接中",
  reconnecting: "重新连接",
  error: "需要处理",
  deleted: "会议已删除",
};

function summaryKey(summary) {
  return `${summary.start_seconds}:${summary.end_seconds}`;
}

export function StageSummaryPanel({
  summaries,
  formatTime,
  status = "idle",
  windowSeconds = 0,
  error = "",
  retrying = false,
  onRetry,
  onJump,
}) {
  const [expandedKeys, setExpandedKeys] = useState(() => new Set());
  const statusLabel = STATUS_LABELS[status] || "等待会议";

  function toggleExpanded(key) {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <aside className="stage-summary-panel ai-insight-panel" aria-label="阶段总结">
      <header className="ai-insight-heading">
        <div>
          <h2>
            <FileText size={14} />
            阶段总结
          </h2>
          <span>按时间整理</span>
        </div>
        <span className={`ai-insight-status ai-insight-status--${status}`}>
          <i />
          {statusLabel}
        </span>
      </header>
      <div className="ai-insight-scroll" aria-live="polite">
        {error && (
          <div className="ai-insight-error" role="alert">
            <p>{error}</p>
            {onRetry && (
              <Button
                variant="ghost"
                size="sm"
                disabled={retrying}
                onClick={onRetry}
              >
                {retrying ? (
                  <LoaderCircle size={13} className="animate-spin" />
                ) : (
                  <RefreshCw size={13} />
                )}
                重试
              </Button>
            )}
          </div>
        )}
        {!summaries.length && !error && (
          <div className="ai-insight-empty">
            {status === "connecting" || status === "reconnecting" ? (
              <>
                <LoaderCircle size={15} className="animate-spin" />
                <span>正在连接阶段总结服务…</span>
              </>
            ) : (
              <>
                <FileText size={15} />
                <span>会议开始后，阶段总结会显示在这里。</span>
              </>
            )}
          </div>
        )}
        {summaries.map((summary) => {
          const key = summaryKey(summary);
          const fullText = String(summary.text || "").trim();
          const excerpt = summaryExcerpt(fullText);
          const truncated = excerpt !== summaryExcerpt(fullText, Infinity);
          const expanded = truncated && expandedKeys.has(key);
          return (
            <article
              className="ai-insight-item"
              key={key}
              aria-label={`${formatTime(summary.start_seconds * 1000)} 至 ${formatTime(summary.end_seconds * 1000)} 阶段总结`}
            >
              <header>
                <strong>
                  <FileText size={12} />
                  阶段总结
                </strong>
                <time>
                  {formatTime(summary.start_seconds * 1000)}–
                  {formatTime(summary.end_seconds * 1000)}
                </time>
              </header>
              <div className="ai-insight-item-body">
                {summary.status === "ready" ? (
                  <p>{expanded ? fullText : excerpt}</p>
                ) : summary.status === "failed" ? (
                  <div className="ai-insight-item-failure">
                    <p>{summary.error || "阶段总结生成失败"}</p>
                    {onRetry && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={retrying}
                        onClick={onRetry}
                      >
                        {retrying ? (
                          <LoaderCircle size={13} className="animate-spin" />
                        ) : (
                          <RefreshCw size={13} />
                        )}
                        重试
                      </Button>
                    )}
                  </div>
                ) : (
                  <p className="ai-insight-item-pending" role="status">
                    <LoaderCircle size={13} className="animate-spin" />
                    正在概括本阶段对话…
                  </p>
                )}
              </div>
              <footer>
                {summary.status === "ready" && truncated && (
                  <button
                    type="button"
                    className="ai-insight-toggle"
                    aria-expanded={expanded}
                    onClick={() => toggleExpanded(key)}
                  >
                    {expanded ? "收起" : "展开全文"}
                  </button>
                )}
                {onJump && (
                  <button
                    type="button"
                    className="ai-insight-jump"
                    onClick={() => onJump(summary)}
                  >
                    查看原文
                    <ArrowUpRight size={12} />
                  </button>
                )}
              </footer>
            </article>
          );
        })}
        {summaries.length > 0 && windowSeconds > 0 && (
          <p className="ai-insight-footnote">
            每 {Math.round(windowSeconds / 60) || 1} 分钟整理一次，点击“查看原文”可回到对应转写。
          </p>
        )}
      </div>
    </aside>
  );
}
