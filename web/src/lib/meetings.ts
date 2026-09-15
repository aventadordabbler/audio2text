export type MeetingStatus = "created" | "recording" | "paused" | "ended"

export interface Meeting {
  id: string
  title: string
  language: string | null
  status: MeetingStatus
  text: string
  text_path: string
  created_at: string
  updated_at: string
  ended_at: string | null
  duration_seconds: number
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
