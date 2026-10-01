export type StageSummaryStatus = "live" | "connecting" | "reconnecting" | "error" | "deleted" | "idle"

export interface StageSummary {
  start_seconds: number
  end_seconds: number
  status: "pending" | "generating" | "ready" | "failed"
  text: string
  error?: string
}
