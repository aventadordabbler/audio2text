import { transcriptRows } from "./transcript.js";

export const EMPTY_FILTERS = {
  title: "",
  departmentId: "all",
  status: "all",
  startDate: "",
  endDate: "",
};
export const MEETING_STATUS_LABELS = {
  created: "未开始",
  recording: "录音中",
  paused: "已暂停",
  ended: "已结束",
};

export function meetingQuery(filters = {}) {
  const { title, departmentId, status, startDate, endDate } = filters;
  if (startDate && endDate && startDate > endDate)
    throw new Error("开始日期不能晚于结束日期");
  const query = {};
  if (title?.trim()) query.title = title.trim();
  if (departmentId && departmentId !== "all")
    query.department_id = departmentId;
  if (status && status !== "all") query.status = status;
  if (startDate)
    query.created_from = new Date(`${startDate}T00:00:00`).toISOString();
  if (endDate) {
    const end = new Date(`${endDate}T00:00:00`);
    end.setDate(end.getDate() + 1);
    query.created_before = end.toISOString();
  }
  return query;
}

export function sessionFromMeeting(meeting, baseUrl, previous = {}) {
  return {
    ...previous,
    id: meeting.id,
    title: meeting.title,
    remoteMeetingId: meeting.id,
    remoteBaseUrl: baseUrl,
    remoteStatus: meeting.status,
    departmentId: meeting.department_id,
    departmentName: meeting.department_name,
    language: meeting.language,
    status: meeting.status === "ended" ? "completed" : meeting.status,
    startedAt: meeting.created_at,
    startedAtLabel: new Date(meeting.created_at).toLocaleString(),
    endedAt: meeting.ended_at || "",
    endedAtLabel: meeting.ended_at
      ? new Date(meeting.ended_at).toLocaleString()
      : "",
    durationSeconds: meeting.duration_seconds || 0,
    audioAvailable: Boolean(meeting.audio_available),
    transcript: transcriptRows(meeting),
    segments: meeting.segments || [],
    speakers: meeting.speakers || {},
    transcriptRevision: meeting.transcript_revision || 0,
    contentRevision: meeting.content_revision || 0,
    nextSegmentId: meeting.next_segment_id || 0,
    processing: meeting.processing || { status: "idle", error: "" },
    summaries: previous.summaries || [],
    minutes: previous.minutes || "",
    errors: previous.errors || [],
  };
}

export function sessionWithMinutes(session, minutes) {
  return {
    ...session,
    minutes: minutes.text || "",
    minutesStatus: minutes.status,
    minutesError: minutes.error || "",
    minutesAvailable: minutes.available,
    minutesStale: minutes.stale,
    minutesFileRevision: minutes.file_revision,
  };
}
