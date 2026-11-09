import { useEffect, useRef, useState } from "react";
import { AudioLines, Clock3, LoaderCircle, Mic, Plus, Search, Square, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PcmRecorder } from "@/services/pcm-recorder.js";

function wavFile(chunks, sampleRate) {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const buffer = new ArrayBuffer(44 + length);
  const view = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + length, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, length, true);
  let offset = 44;
  for (const chunk of chunks) { new Uint8Array(buffer, offset, chunk.byteLength).set(chunk); offset += chunk.byteLength; }
  return new File([buffer], "voiceprint.wav", { type: "audio/wav" });
}

export function VoiceprintManagement({ api, departments, readOnly = false }) {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [mode, setMode] = useState("recording");
  const [file, setFile] = useState(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [error, setError] = useState("");
  const [searchName, setSearchName] = useState("");
  const [filterDepartment, setFilterDepartment] = useState("all");
  const recorder = useRef(null);
  const chunks = useRef([]);
  const sampleRate = useRef(16000);

  async function load() {
    if (!api) return;
    try { setRows(await api.voiceprints()); } catch (loadError) { setError(loadError.message); }
  }
  useEffect(() => { void load(); return () => recorder.current?.close(); }, [api]);

  function resetForm() {
    recorder.current?.close(); recorder.current = null; setRecording(false);
    setName(""); setDepartmentId(departments[0]?.id || ""); setMode("recording"); setFile(null); chunks.current = []; setError("");
  }
  function startCreate() { resetForm(); setOpen(true); }
  function closeCreate(next) { if (!next && !busy) { resetForm(); setOpen(false); } }

  async function startRecording() {
    setError(""); chunks.current = [];
    try {
      const instance = await PcmRecorder.create((bytes) => chunks.current.push(new Uint8Array(bytes)), (recordError) => setError(recordError.message), 1);
      recorder.current = instance; sampleRate.current = instance.sampleRate; await instance.resume(); setRecording(true); setFile(null);
    } catch (startError) { setError(startError.message); }
  }
  function stopRecording() {
    recorder.current?.close(); recorder.current = null; setRecording(false);
    if (chunks.current.length) setFile(wavFile(chunks.current, sampleRate.current));
  }
  async function submit(event) {
    event.preventDefault();
    if (!api || busy || !name.trim() || !departmentId || !file) return;
    setBusy(true); setError("");
    try {
      const body = new FormData(); body.set("name", name.trim()); body.set("department_id", departmentId); body.set("source", mode); body.set("file", file);
      await api.createVoiceprint(body); await load(); setOpen(false); resetForm();
    } catch (submitError) { setError(submitError.message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!deleting || busy) return;
    setBusy(true); setError("");
    try { await api.deleteVoiceprint(deleting.id); await load(); setDeleting(null); } catch (removeError) { setError(removeError.message); } finally { setBusy(false); }
  }

  const filteredRows = rows.filter((row) =>
    (!searchName.trim() || row.name.toLocaleLowerCase().includes(searchName.trim().toLocaleLowerCase())) &&
    (filterDepartment === "all" || row.department_id === filterDepartment)
  );
  const resetFilters = () => { setSearchName(""); setFilterDepartment("all"); };

  return <section className="page-content management-page">
    <div className="page-heading"><div><h1>声纹管理</h1></div>{!readOnly && <Button className="h-10 shrink-0 gap-2 px-4 shadow-sm" onClick={startCreate} disabled={!departments.length}><Plus size={15} />创建声纹</Button>}</div>
    {!api && <div className="management-error">请先配置会议服务地址。</div>}
    {!readOnly && !departments.length && <div className="management-error">请先创建部门，再录入声纹。</div>}
    {error && !open && <div className="management-error" role="alert">{error}</div>}
    <div className="voiceprint-filters" role="search" aria-label="筛选声纹">
      <div className="filter-field">
        <Label className="sr-only" htmlFor="voiceprint-search">姓名</Label>
        <div className="search-field"><Search size={15} /><Input id="voiceprint-search" placeholder="搜索姓名" value={searchName} onChange={(event) => setSearchName(event.target.value)} />{searchName && <button type="button" aria-label="清空姓名搜索" onClick={() => setSearchName("")}><X size={13} /></button>}</div>
      </div>
      <div className="filter-field">
        <Label className="sr-only" htmlFor="voiceprint-department-filter">部门</Label>
        <Select value={filterDepartment} onValueChange={setFilterDepartment}><SelectTrigger id="voiceprint-department-filter"><SelectValue placeholder="全部部门" /></SelectTrigger><SelectContent position="popper" side="bottom" align="start" sideOffset={4} avoidCollisions={false} className="meeting-filter-menu"><SelectItem value="all">全部部门</SelectItem>{departments.map((department) => <SelectItem key={department.id} value={department.id}>{department.name}</SelectItem>)}</SelectContent></Select>
      </div>
      <Button variant="ghost" onClick={resetFilters} disabled={!searchName && filterDepartment === "all"}>重置筛选</Button>
    </div>
    <Card className="history-table-card"><div className="history-table-scroll panel-scroll management-table"><Table><TableHeader><TableRow><TableHead>人员姓名</TableHead><TableHead>所属部门</TableHead><TableHead>录入类型</TableHead><TableHead>录音时长</TableHead><TableHead>创建时间</TableHead>{!readOnly && <TableHead>操作</TableHead>}</TableRow></TableHeader><TableBody>
      {filteredRows.map((row) => <TableRow key={row.id}><TableCell><span className="voiceprint-person"><span className="voiceprint-avatar"><AudioLines size={15} /></span><strong>{row.name}</strong></span></TableCell><TableCell>{row.department_name || "未分类"}</TableCell><TableCell>{row.source === "recording" ? "在线" : "离线"}</TableCell><TableCell><span className="table-cell-value inline-flex items-center gap-1.5 font-mono"><Clock3 size={13} />{Math.floor(row.duration_seconds / 60).toString().padStart(2, "0")}:{Math.floor(row.duration_seconds % 60).toString().padStart(2, "0")}</span></TableCell><TableCell>{new Date(row.created_at).toLocaleString("zh-CN")}</TableCell>{!readOnly && <TableCell><Button type="button" variant="ghost" size="icon" aria-label={`删除声纹：${row.name}`} onClick={() => { setDeleting(row); setError(""); }} disabled={busy}><Trash2 size={15} /></Button></TableCell>}</TableRow>)}
      {!filteredRows.length && <TableRow className="hover:bg-transparent"><TableCell colSpan={readOnly ? 5 : 6} className="whitespace-normal"><div className="empty-state"><div className="empty-illustration"><span /><span /><div><AudioLines /></div></div><h3>{rows.length ? "没有找到匹配的声纹" : "还没有声纹记录"}</h3><p>{rows.length ? "请调整姓名或部门筛选条件。" : "创建声纹后，会议转写会尝试显示登记的人员姓名。"}</p>{!readOnly && <Button variant={rows.length ? "outline" : "default"} onClick={rows.length ? resetFilters : startCreate} disabled={!rows.length && !departments.length}>{rows.length ? "重置筛选" : <><Plus size={15} />创建第一条声纹</>}</Button>}</div></TableCell></TableRow>}
    </TableBody></Table></div></Card>
    <Dialog open={open} onOpenChange={closeCreate}><DialogContent className="management-dialog"><form className="management-form" onSubmit={submit}><DialogHeader><DialogTitle>创建声纹</DialogTitle><DialogDescription>录入人员姓名、部门和一段清晰的单人讲话音频。</DialogDescription></DialogHeader>
      <Label className="form-field"><span>人员姓名</span><Input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="例如：张三" disabled={busy || recording} required /></Label>
      <Label className="form-field"><span>所属部门</span><Select value={departmentId} onValueChange={setDepartmentId} disabled={busy || recording}><SelectTrigger aria-label="所属部门"><SelectValue placeholder="选择部门" /></SelectTrigger><SelectContent position="popper" side="bottom" align="start" sideOffset={4} avoidCollisions={false} className="meeting-filter-menu">{departments.map((department) => <SelectItem key={department.id} value={department.id}>{department.name}</SelectItem>)}</SelectContent></Select></Label>
      <div className="form-field"><span>录入方式</span><div className="voiceprint-source-tabs"><Button type="button" disabled={recording || busy} variant={mode === "recording" ? "secondary" : "ghost"} onClick={() => { setMode("recording"); setFile(null); }}><Mic size={15} />在线录音</Button><Button type="button" disabled={recording || busy} variant={mode === "import" ? "secondary" : "ghost"} onClick={() => { setMode("import"); setFile(null); }}><Upload size={15} />导入音频</Button></div></div>
      {mode === "recording" ? <div className="voiceprint-recorder"><Button type="button" variant={recording ? "destructive" : "default"} onClick={recording ? stopRecording : startRecording}>{recording ? <><Square size={14} />停止录音</> : <><Mic size={14} />在线录音</>}</Button>{file && !recording && <span>录音已就绪</span>}</div> : <Label className="voiceprint-upload-button"><Upload size={15} />音频上传<Input className="sr-only" type="file" accept="audio/wav,audio/mpeg,audio/mp4,audio/flac,audio/ogg" onChange={(event) => setFile(event.target.files?.[0] || null)} disabled={busy} /></Label>}
      {file && <p className="voiceprint-file">{file.name} · {(file.size / 1024).toFixed(0)} KB</p>}
      {error && <p className="management-error" role="alert">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" onClick={() => closeCreate(false)} disabled={busy || recording}>取消</Button><Button type="submit" disabled={busy || recording || !file || !name.trim() || !departmentId}>{busy ? <LoaderCircle className="animate-spin" /> : <AudioLines />}保存声纹</Button></DialogFooter>
    </form></DialogContent></Dialog>
    <Dialog open={!!deleting} onOpenChange={(next) => { if (!next && !busy) { setDeleting(null); setError(""); } }}><DialogContent className="management-dialog"><DialogHeader><DialogTitle>删除声纹</DialogTitle><DialogDescription>确认删除声纹「{deleting?.name}」？删除后将无法恢复。</DialogDescription></DialogHeader>{error && <p className="management-error" role="alert">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => { setDeleting(null); setError(""); }}>取消</Button><Button disabled={busy} onClick={remove}>{busy && <LoaderCircle className="animate-spin" />}确认删除</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
