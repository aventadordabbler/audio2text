import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createStageSummaryBubbleState,
  removeStageSummaryBubble,
  reconcileStageSummaryBubbles,
  summaryExcerpt,
} from "../src/services/stage-summary-bubbles.js";

function summary(start, status = "ready") {
  return {
    start_seconds: start,
    end_seconds: start + 60,
    status,
    text: `第 ${start / 60 + 1} 阶段`,
  };
}

test("a stage summary bubble shows no more than 80 characters by default", () => {
  assert.equal(summaryExcerpt("摘".repeat(81)), `${"摘".repeat(80)}…`);
});

test("an existing meeting opens with only its two latest stage summary bubbles", () => {
  const state = reconcileStageSummaryBubbles(
    createStageSummaryBubbleState(),
    [summary(0), summary(60), summary(120)],
  );

  assert.deepEqual(
    state.bubbles.map(({ summary: item, exiting }) => [
      item.start_seconds,
      exiting,
    ]),
    [
      [60, false],
      [120, false],
    ],
  );
});

test("a new stage summary keeps two active bubbles while the oldest fades out", () => {
  const initial = reconcileStageSummaryBubbles(
    createStageSummaryBubbleState(),
    [summary(0), summary(60)],
  );
  const state = reconcileStageSummaryBubbles(initial, [
    summary(0),
    summary(60),
    summary(120),
  ]);

  assert.deepEqual(
    state.bubbles.map(({ summary: item, exiting }) => [
      item.start_seconds,
      exiting,
    ]),
    [
      [0, true],
      [60, false],
      [120, false],
    ],
  );
});

test("an expired historical bubble is removed after its fade animation", () => {
  const initial = reconcileStageSummaryBubbles(
    createStageSummaryBubbleState(),
    [summary(0), summary(60)],
  );
  const overflowing = reconcileStageSummaryBubbles(initial, [
    summary(0),
    summary(60),
    summary(120),
  ]);

  const state = removeStageSummaryBubble(overflowing, "0:60");

  assert.deepEqual(
    state.bubbles.map(({ summary: item }) => item.start_seconds),
    [60, 120],
  );
});
