export type MeetingStatus = "created" | "recording" | "paused" | "ended"

export interface TranscriptSegment {
  segment_id: number
  start_ms: number
  end_ms: number
  text: string
  speaker_ids: string[]
  speaker_status: "pending" | "assigned" | "unknown" | "multiple" | "overlap"
  speaker_turns?: { start_ms: number; end_ms: number; speaker_ids: string[]; unknown?: boolean; overlap?: boolean }[]
}

export interface ProcessingState {
  status: "idle" | "pending" | "queued" | "running" | "ready" | "failed" | "unavailable"
  error: string
}

export interface ImportJob {
  status: "queued" | "running" | "ready" | "failed"
  stage: "initializing" | "transcribing" | "diarizing" | "summarizing"
  filename: string
  error: string
  processed_samples: number
  total_samples: number
}

export function importStatusLabel(job?: ImportJob | null) {
  if (!job) return ""
  if (job.status === "ready") return "导入处理完成"
  if (job.status === "failed") return "导入处理失败"
  if (job.stage === "initializing") return "正在初始化"
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
  minutes_format_id?: string | null
  minutes_format_name?: string | null
  key_speakers: { voiceprint_id: string; name: string; status: "detected" | "not_detected" }[]
  creator_account: string | null
  creator_employee_id: string | null
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

export interface Voiceprint {
  id: string
  name: string
  department_id: string | null
  department_name: string | null
}

export interface Department {
  id: string
  name: string
  created_at: string
  updated_at: string
  meeting_count: number
}

export interface UserAccount {
  id: string
  account: string
  employee_id: string
  department_id: string
  department_name: string
  is_admin: boolean
  is_department_admin: boolean
}

export interface MinutesFormat {
  id: string
  name: string
  prompt: string
  is_default: boolean
  created_at: string
  updated_at: string
  meeting_count: number
}

export interface SystemSettings {
  slogan: string
  asr_use_request_chat_template: boolean
  llm_max_tokens: number
  llm_chunk_chars: number
  stage_summary_window_seconds: number
  stage_summary_max_tokens: number
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

export const STT_LANGUAGE_OPTIONS = [
  { value: "auto", label: "自动检测" },
  { value: "Chinese", label: "中文" },
  { value: "English", label: "English" },
  { value: "Cantonese", label: "粤语" },
  { value: "Arabic", label: "العربية" },
  { value: "German", label: "Deutsch" },
  { value: "French", label: "Français" },
  { value: "Spanish", label: "Español" },
  { value: "Portuguese", label: "Português" },
  { value: "Indonesian", label: "Bahasa Indonesia" },
  { value: "Italian", label: "Italiano" },
  { value: "Korean", label: "한국어" },
  { value: "Russian", label: "Русский" },
  { value: "Thai", label: "ไทย" },
  { value: "Vietnamese", label: "Tiếng Việt" },
  { value: "Turkish", label: "Türkçe" },
  { value: "Hindi", label: "हिन्दी" },
  { value: "Malay", label: "Bahasa Melayu" },
  { value: "Dutch", label: "Nederlands" },
  { value: "Swedish", label: "Svenska" },
  { value: "Danish", label: "Dansk" },
  { value: "Finnish", label: "Suomi" },
  { value: "Polish", label: "Polski" },
  { value: "Czech", label: "Čeština" },
  { value: "Filipino", label: "Filipino" },
  { value: "Persian", label: "فارسی" },
  { value: "Greek", label: "Ελληνικά" },
  { value: "Hungarian", label: "Magyar" },
  { value: "Macedonian", label: "Македонски" },
  { value: "Romanian", label: "Română" },
] as const

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

const AUTH_TOKEN_KEY = "meeting-auth-token"

export function authToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || ""
}

export function setAuthToken(token: string | null) {
  if (token) localStorage.setItem(AUTH_TOKEN_KEY, token)
  else localStorage.removeItem(AUTH_TOKEN_KEY)
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = authToken()
  const response = await fetch(path, {
    ...options,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  })
  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    setAuthToken(null)
    window.dispatchEvent(new Event("auth-expired"))
  }
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

const CHUNK_SIZE = 8 * 1024 * 1024

async function sha256Hex(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")
}

export async function importWav(
  input: File | File[],
  title: string,
  language: string,
  minutesFormatId: string | null = null,
  onProgress?: (completed: number, total: number) => void,
  keySpeakerIds: string[] = [],
) {
  const files = Array.isArray(input) ? input : [input]
  const totalChunks = files.reduce((total, file) => total + Math.ceil(file.size / CHUNK_SIZE), 0)
  const started = await api<{ upload_id: string; meeting: Meeting }>("/api/meetings/import/chunked", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      language: language === "auto" ? null : language,
      minutes_format_id: minutesFormatId,
      key_speaker_ids: keySpeakerIds,
      files: files.map((file) => ({
        filename: file.name,
        file_size: file.size,
        total_chunks: Math.ceil(file.size / CHUNK_SIZE),
        chunk_size: CHUNK_SIZE,
      })),
    }),
  })
  const upload = (async () => {
    try {
      let completed = 0
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        const file = files[fileIndex]
        const fileChunks = Math.ceil(file.size / CHUNK_SIZE)
        for (let index = 0; index < fileChunks; index += 1) {
          const chunk = file.slice(index * CHUNK_SIZE, Math.min(file.size, (index + 1) * CHUNK_SIZE))
          await api(`/api/meetings/import/chunked/${started.upload_id}/file/${fileIndex}/${index}`, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": await sha256Hex(chunk) },
            body: chunk,
          })
          completed += 1
          onProgress?.(completed, totalChunks)
        }
      }
      await api<Meeting>(`/api/meetings/import/chunked/${started.upload_id}/complete`, { method: "POST" })
    } catch (error) {
      await api(`/api/meetings/import/chunked/${started.upload_id}/fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: errorMessage(error) }),
      }).catch(() => {})
      throw error
    }
  })()
  return { meeting: started.meeting, upload }
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
