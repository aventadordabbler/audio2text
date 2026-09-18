import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, RefreshCw, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  createStageSummaryBubbleState,
  reconcileStageSummaryBubbles,
  removeStageSummaryBubble,
  summaryExcerpt,
} from "@/services/stage-summary-bubbles.js";

const EXIT_MILLISECONDS = 420;

export function StageSummaryBubbles({
  summaries,
  formatTime,
  error = "",
  retrying = false,
  onRetry,
}) {
  const [state, setState] = useState(createStageSummaryBubbleState);
  const [expandedKeys, setExpandedKeys] = useState(() => new Set());

  useEffect(() => {
    setState((current) => reconcileStageSummaryBubbles(current, summaries));
  }, [summaries]);

  const exitingKeys = useMemo(
    () =>
      state.bubbles
        .filter((bubble) => bubble.exiting)
        .map((bubble) => bubble.key)
        .join("|"),
    [state.bubbles],
  );

  useEffect(() => {
    if (!exitingKeys) return undefined;
    const delay = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ? 0
      : EXIT_MILLISECONDS;
    const timer = window.setTimeout(() => {
      const expired = new Set(exitingKeys.split("|"));
      setState((current) =>
        [...expired].reduce(
          (next, key) => removeStageSummaryBubble(next, key),
          current,
        ),
      );
      setExpandedKeys((current) => {
        const next = new Set(
          [...current].filter((key) => !expired.has(key)),
        );
        return next.size === current.size ? current : next;
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [exitingKeys]);

  if (!state.bubbles.length && !error) return null;

  function toggleExpanded(key) {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div
      className="stage-summary-bubbles"
      aria-label="阶段总结气泡"
      aria-live="polite"
    >
      {error && (
        <div className="stage-summary-bubble stage-summary-bubble--error" role="alert">
          <p>{error}</p>
        </div>
      )}
      {state.bubbles.map(({ key, summary, exiting }) => {
        const fullText = String(summary.text || "").trim();
        const excerpt = summaryExcerpt(fullText);
        const truncated = excerpt !== summaryExcerpt(fullText, Infinity);
        const expanded = truncated && expandedKeys.has(key);
        return (
          <section
            className={`stage-summary-bubble${exiting ? " stage-summary-bubble--exiting" : ""}`}
            key={key}
            aria-label={`${formatTime(summary.start_seconds * 1000)} 至 ${formatTime(summary.end_seconds * 1000)} 阶段总结`}
          >
            <header>
              <strong>
                <Sparkles size={13} />
                阶段总结
              </strong>
              <time>
                {formatTime(summary.start_seconds * 1000)}–
                {formatTime(summary.end_seconds * 1000)}
              </time>
            </header>
            <div
              className={`stage-summary-bubble-body${expanded ? " stage-summary-bubble-body--expanded" : ""}`}
            >
              {summary.status === "ready" ? (
                <p className="stage-summary-bubble-copy">
                  {expanded ? fullText : excerpt}
                </p>
              ) : summary.status === "failed" ? (
                <div className="stage-summary-bubble-failure">
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
                <p className="stage-summary-bubble-pending" role="status">
                  <LoaderCircle size={13} className="animate-spin" />
                  正在概括本阶段对话…
                </p>
              )}
            </div>
            {summary.status === "ready" && truncated && (
              <button
                className="stage-summary-bubble-toggle"
                type="button"
                aria-expanded={expanded}
                onClick={() => toggleExpanded(key)}
              >
                {expanded ? "收起" : "展开全文"}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}
