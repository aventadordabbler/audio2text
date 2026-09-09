const $ = (selector) => document.querySelector(selector);
const startButton = $("#start-button");
const stopButton = $("#stop-button");
const transcript = $("#transcript");
const transcriptState = $("#transcript-state");
const errorMessage = $("#error-message");
const statusChip = $("#connection-status");
const visualizer = $(".visualizer");
const byteCount = $("#byte-count");
let socket;
let recorder;
let startedAt;
let timerHandle;
let pendingAudioSends = [];
let stopping = false;

function setStatus(label, online) { statusChip.classList.toggle("online", online); statusChip.classList.toggle("offline", !online); statusChip.lastChild.textContent = label; }
function showError(message) { errorMessage.textContent = message || ""; }
function updateTimer() { const seconds = Math.floor((Date.now() - startedAt) / 1000); const minutes = String(Math.floor(seconds / 60)).padStart(2, "0"); const remainder = String(seconds % 60).padStart(2, "0"); $("#recording-time").textContent = minutes + ":" + remainder; }
function wsUrl() { return (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/ws/transcribe"; }
function openSocket() {
  socket = new WebSocket(wsUrl());
  socket.onopen = () => setStatus("已连接", true);
  socket.onclose = () => setStatus("未连接", false);
  socket.onerror = () => showError("无法连接到转写服务，请确认后端已启动。");
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "ready") transcriptState.textContent = "正在监听";
    if (message.type === "transcript") { transcript.classList.remove("empty"); transcript.textContent = message.text || "等待语音内容…"; transcriptState.textContent = message.is_final ? "识别完成" : "实时识别中"; byteCount.textContent = Math.round(message.bytes / 1024) + " KB 音频"; }
    if (message.type === "error") { showError(message.message); if (stopping) { stopping = false; startButton.disabled = false; socket?.close(); } }
    if (message.type === "archived") { transcriptState.textContent = "已归档"; loadArchives(); stopping = false; startButton.disabled = false; setTimeout(() => socket?.close(), 100); }
  };
}
async function waitForSocket() {
  await new Promise((resolve, reject) => {
    const untilReady = () => socket?.readyState === WebSocket.OPEN ? resolve() : setTimeout(untilReady, 40);
    setTimeout(() => reject(new Error("连接超时")), 5000);
    untilReady();
  });
}
async function startRecording() {
  showError("");
  if (!navigator.mediaDevices?.getUserMedia) { showError("当前浏览器不支持麦克风采集。"); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    openSocket();
    await waitForSocket();
    if (typeof MediaRecorder === "undefined") throw new Error("当前浏览器不支持录音");
    const mimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    const mimeType = mimeTypes.find((value) => MediaRecorder.isTypeSupported(value));
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    startedAt = Date.now();
    timerHandle = setInterval(updateTimer, 250);
    visualizer.classList.add("active");
    socket.send(JSON.stringify({ type: "start", title: $("#title-input").value, language: $("#language-input").value, mime_type: recorder.mimeType || "audio/webm" }));
    pendingAudioSends = [];
    recorder.ondataavailable = (event) => { if (event.data.size && socket?.readyState === WebSocket.OPEN) { const send = event.data.arrayBuffer().then((buffer) => socket.send(buffer)); pendingAudioSends.push(send); } };
    recorder.onstop = async () => { await Promise.all(pendingAudioSends); if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop", title: $("#title-input").value, language: $("#language-input").value })); };
    recorder.start(2500);
    stopping = false;
    startButton.disabled = true;
    stopButton.disabled = false;
  } catch (error) { stream?.getTracks().forEach((track) => track.stop()); socket?.close(); showError("无法开始录音：" + error.message); }
}
function stopRecording() { if (!recorder) return; stopping = true; recorder.stop(); recorder.stream.getTracks().forEach((track) => track.stop()); clearInterval(timerHandle); visualizer.classList.remove("active"); stopButton.disabled = true; recorder = null; }
async function loadArchives() {
  const response = await fetch("/api/archives");
  const archives = await response.json();
  const list = $("#archive-list");
  if (!archives.length) { list.innerHTML = '<p class="muted">暂无归档记录</p>'; return; }
  list.innerHTML = archives.map((archive) => '<div class="archive-item"><div><h3>' + escapeHtml(archive.title) + '</h3><p>' + new Date(archive.created_at).toLocaleString() + " · " + escapeHtml(archive.text || "无文本") + '</p></div><div class="archive-actions"><a href="/api/archives/' + archive.id + '" target="_blank">查看</a><a href="/api/archives/' + archive.id + '/download">下载</a></div></div>').join("");
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
startButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", stopRecording);
$("#refresh-button").addEventListener("click", loadArchives);
loadArchives();
