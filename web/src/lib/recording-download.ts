export async function downloadRecording(id: string) {
  const url = `/api/meetings/${encodeURIComponent(id)}/audio/download`
  const response = await fetch(url, {
    method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) {
    throw new Error(response.status === 404
      ? "会议暂无可导出的录音，请刷新后重试"
      : `录音归档无法导出（HTTP ${response.status}）`)
  }
  // Use the browser download manager, keeping large WAV files out of JS memory.
  // The frame also keeps a failed GET from replacing the meeting page.
  let frame = document.querySelector<HTMLIFrameElement>("#recording-download-frame")
  if (!frame) {
    frame = document.createElement("iframe")
    frame.id = "recording-download-frame"
    frame.hidden = true
    frame.title = "录音下载"
    document.body.appendChild(frame)
  }
  frame.src = url
}
