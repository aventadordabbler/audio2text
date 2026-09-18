const MAX_BUBBLES = 2;

function summaryKey(summary) {
  return `${summary.start_seconds}:${summary.end_seconds}`;
}

export function createStageSummaryBubbleState() {
  return { initialized: false, knownKeys: [], bubbles: [] };
}

export function removeStageSummaryBubble(state, key) {
  return {
    ...state,
    bubbles: state.bubbles.filter((bubble) => bubble.key !== key),
  };
}

export function reconcileStageSummaryBubbles(state, summaries) {
  const rows = [...summaries].sort(
    (left, right) => left.start_seconds - right.start_seconds,
  );
  if (!state.initialized && !rows.length) return state;
  if (!state.initialized) {
    return {
      initialized: true,
      knownKeys: rows.map(summaryKey),
      bubbles: rows.slice(-MAX_BUBBLES).map((summary) => ({
        key: summaryKey(summary),
        summary,
        exiting: false,
      })),
    };
  }

  const byKey = new Map(rows.map((summary) => [summaryKey(summary), summary]));
  const known = new Set(state.knownKeys);
  const retained = state.bubbles
    .filter((bubble) => byKey.has(bubble.key))
    .map((bubble) => ({ ...bubble, summary: byKey.get(bubble.key) }));
  const candidates = [
    ...retained.filter((bubble) => !bubble.exiting),
    ...rows
      .filter((summary) => !known.has(summaryKey(summary)))
      .map((summary) => ({
        key: summaryKey(summary),
        summary,
        exiting: false,
      })),
  ].sort(
    (left, right) =>
      left.summary.start_seconds - right.summary.start_seconds,
  );
  const active = candidates.slice(-MAX_BUBBLES);
  const activeKeys = new Set(active.map((bubble) => bubble.key));
  const exiting = [
    ...retained.filter((bubble) => bubble.exiting),
    ...candidates.filter((bubble) => !activeKeys.has(bubble.key)),
  ].map((bubble) => ({ ...bubble, exiting: true }));

  return {
    initialized: true,
    knownKeys: rows.map(summaryKey),
    bubbles: [...exiting, ...active].sort(
      (left, right) =>
        left.summary.start_seconds - right.summary.start_seconds,
    ),
  };
}
