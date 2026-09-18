import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, RefreshCw, Sparkles } from "lucide-react";

import MinutesMarkdown from "@/components/minutes-markdown";
import { Button } from "@/components/ui/button";
import {
  createStageSummaryBubbleState,
  reconcileStageSummaryBubbles,
  removeStageSummaryBubble,
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
    }, delay);
    return () => window.clearTimeout(timer);
  }, [exitingKeys]);

  if (!state.bubbles.length && !error) return null;

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
      {state.bubbles.map(({ key, summary, exiting }) => (
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
          <div className="stage-summary-bubble-body">
            {summary.status === "ready" ? (
              <div className="minutes-document">
                <MinutesMarkdown text={summary.text} />
              </div>
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
        </section>
      ))}
    </div>
  );
}
