// The server may revise earlier words: rebuild from the latest full text.
export function replaceTranscript(previous, text, timeLabel) {
  const sentences = String(text || "").match(/[^。！？!?；;\n]+[。！？!?；;]*(?:["'”’》】）)])?/g) || [];
  return sentences.map((sentence) => sentence.trim()).filter(Boolean).map((sentence, index) => ({
    timeLabel: previous[index]?.text === sentence ? previous[index].timeLabel : timeLabel,
    text: sentence,
  }));
}
// Revisions include processing events as well as text/speaker changes.
// A gap must be repaired with a server snapshot before applying more events.
export function applyTranscriptEvent(meeting, event) {
  const revision = meeting.transcript_revision || 0;
  if (event.revision <= revision) return meeting;
  if (!Number.isInteger(event.revision) || event.revision !== revision + 1)
    return null;
  const removed = new Set(event.remove_segment_ids || []);
  const segments = new Map(
    (meeting.segments || []).filter((s) => !removed.has(s.segment_id))
      .map((s) => [s.segment_id, s]),
  );
  for (const segment of event.upsert_segments || [])
    segments.set(segment.segment_id, segment);
  const ordered = [...segments.values()].sort(
    (a, b) => a.start_ms - b.start_ms || a.segment_id - b.segment_id,
  );
  const changed = Boolean(event.upsert_segments?.length || event.remove_segment_ids?.length || Object.keys(event.speakers || {}).length);
  return {
    ...meeting,
    segments: ordered,
    text: ordered.map((s) => s.text).filter(Boolean).join("\n\n"),
    speakers: { ...meeting.speakers, ...event.speakers },
    processing: event.processing || meeting.processing,
    transcript_revision: event.revision,
    content_revision: changed ? event.revision : meeting.content_revision,
    next_segment_id: Math.max(meeting.next_segment_id || 0, event.next_segment_id || 0),
  };
}

export function speakerLabel(segment, speakers = {}) {
  if (["pending", "unknown"].includes(segment.speaker_status)) return "说话人待确认";
  const names = (segment.speaker_ids || []).map((id) => speakers[id]?.name || "未知说话人");
  const unresolved = (segment.speaker_turns || []).some((turn) => turn.unknown);
  let label = names.join("、");
  if (segment.speaker_status === "multiple" && unresolved)
    label = `${label}${label ? "、" : ""}说话人待确认`;
  if (segment.speaker_status === "multiple") return label || "多位说话人";
  if (segment.speaker_status === "overlap") return `多人同时讲话${label ? `：${label}` : ""}`;
  return label || "说话人待确认";
}

export function transcriptRows(meeting) {
  if (!meeting.segments?.length)
    return meeting.text ? [{ segment_id: "archive", text: meeting.text, timeLabel: "—", speakerLabel: "说话人待确认" }] : [];
  return meeting.segments.map((segment) => {
    const seconds = Math.max(0, Math.floor(segment.start_ms / 1000));
    return {
      ...segment,
      timeLabel: [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .map((value) => String(value).padStart(2, "0")).join(":"),
      speakerLabel: speakerLabel(segment, meeting.speakers),
    };
  });
}
