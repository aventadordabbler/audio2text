export type MeetingStatus = "created" | "recording" | "paused" | "ended"

export interface TranscriptSegment {
  segment_id: number
  start_ms: number
  end_ms: number
  text: string
  speaker_ids: string[]
  speaker_status: "pending" | "assigned" | "unknown" | "multiple" | "overlap"
  speaker_turns?: { start_ms: number; end_ms: number; speaker_ids: string[] }[]
}

export interface ProcessingState {
  status: "idle" | "pending" | "queued" | "running" | "ready" | "failed" | "unavailable"
  error: string
}

export interface ImportJob {
  status: "queued" | "running" | "ready" | "failed"
  stage: "transcribing" | "diarizing" | "summarizing"
  filename: string
  error: string
  processed_samples: number
  total_samples: number
}

export function importStatusLabel(job?: ImportJob | null) {
  if (!job) return ""
  if (job.status === "ready") return "导入处理完成"
  if (job.status === "failed") return "导入处理失败"
  if (job.status === "queued") return "等待处理音频"
  return { transcribing: "正在转写音频", diarizing: "正在校正说话人", summarizing: "正在生成会议纪要" }[job.stage]
}

export interface Meeting {
  source?: "recording" | "wav"
  import_job?: ImportJob | null
  id: string
  title: string
  language: string | null
  department_id: string | null
  department_name: string | null
  status: MeetingStatus
  text: string
  text_path: string
  created_at: string
  updated_at: string
  ended_at: string | null
  duration_seconds: number
  audio_available: boolean
  segments: TranscriptSegment[]
  speakers: Record<string, { name: string }>
  transcript_revision: number
  content_revision: number
  minutes_version?: number
  next_segment_id: number
  processing: ProcessingState
}

export interface Department {
  id: string
  name: string
  created_at: string
  updated_at: string
  meeting_count: number
}

export interface MeetingFilters {
  title: string
  departmentId: string
  status: MeetingStatus | "all"
  startDate: string
  endDate: string
}

export const emptyMeetingFilters: MeetingFilters = {
  title: "", departmentId: "all", status: "all", startDate: "", endDate: "",
}

export const statusLabels: Record<MeetingStatus, string> = {
  created: "未开始",
  recording: "录音中",
  paused: "已暂停",
  ended: "已结束",
}

export const languageLabels: Record<string, string> = {
  zh: "中文",
  en: "English",
  ja: "日本語",
  Chinese: "中文",
  English: "English",
  Japanese: "日本語",
}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, options)
  if (!response.ok) {
    const result = await response.json().catch(() => null)
    const detail = result?.detail
    throw new ApiError(
      typeof detail === "string"
        ? detail
        : Array.isArray(detail) && detail[0]?.msg
          ? detail[0].msg
          : "请求未成功，请稍后重试。",
      response.status,
    )
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  return [Math.floor(total / 60), total % 60]
    .map((value) => String(value).padStart(2, "0"))
    .join(":")
}

export function formatDate(value: string, includeTime = true) {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeTime ? ({ hour: "2-digit", minute: "2-digit" } as const) : {}),
  })
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请重试。"
}
