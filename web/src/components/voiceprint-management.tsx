import { useEffect, useRef, useState, type FormEvent } from "react"
import { ArrowRight, AudioLines, Clock3, LoaderCircle, Mic, Plus, Search, Square, Trash2, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PcmRecorder } from "@/lib/pcm-recorder"
import { api, errorMessage, formatDate, formatDuration, type Department } from "@/lib/meetings"

interface Voiceprint {
  id: string
  name: string
  department_id: string | null
  department_name: string | null
  duration_seconds: number
  source: "recording" | "import"
  created_at: string
}

function wavFile(chunks: Uint8Array[], sampleRate: number) {
  const dataLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  text(0, "RIFF"); view.setUint32(4, 36 + dataLength, true); text(8, "WAVE"); text(12, "fmt ")
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, dataLength, true)
  let offset = 44
  for (const chunk of chunks) { new Uint8Array(buffer, offset, chunk.byteLength).set(chunk); offset += chunk.byteLength }
  return new File([buffer], "voiceprint.wav", { type: "audio/wav" })
}

export function VoiceprintManagement({ departments, readOnly = false }: { departments: Department[]; readOnly?: boolean }) {
  const [rows, setRows] = useState<Voiceprint[]>([])
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [departmentId, setDepartmentId] = useState("")
  const [mode, setMode] = useState<"recording" | "import">("recording")
  const [file, setFile] = useState<File | null>(null)
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<Voiceprint | null>(null)
  const [error, setError] = useState("")
  const [searchName, setSearchName] = useState("")
  const [filterDepartment, setFilterDepartment] = useState("all")
  const recorder = useRef<PcmRecorder | null>(null)
  const chunks = useRef<Uint8Array[]>([])
  const sampleRate = useRef(16000)

  async function load() {
    try { setRows(await api<Voiceprint[]>("/api/voiceprints")) } catch (error) { setError(errorMessage(error)) }
  }
  useEffect(() => { void load(); return () => recorder.current?.close() }, [])

  function resetForm() {
    recorder.current?.close(); recorder.current = null; setRecording(false)
    setName(""); setDepartmentId(departments[0]?.id || ""); setMode("recording"); setFile(null); chunks.current = []; setError("")
  }
  function startCreate() { resetForm(); setOpen(true) }
  function closeCreate(next: boolean) { if (!next && !busy) { resetForm(); setOpen(false) } }

  async function startRecording() {
    setError(""); chunks.current = []
    try {
      const instance = await PcmRecorder.create((bytes) => chunks.current.push(new Uint8Array(bytes)), (error) => setError(error.message))
      recorder.current = instance; sampleRate.current = instance.sampleRate; await instance.resume(); setRecording(true); setFile(null)
    } catch (error) { setError(errorMessage(error)) }
  }
  function stopRecording() {
    recorder.current?.close(); recorder.current = null; setRecording(false)
    if (chunks.current.length) setFile(wavFile(chunks.current, sampleRate.current))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim() || !departmentId || !file || busy) return
    setBusy(true); setError("")
    try {
      const body = new FormData(); body.set("name", name.trim()); body.set("department_id", departmentId); body.set("source", mode); body.set("file", file)
      await api<Voiceprint>("/api/voiceprints", { method: "POST", body }); await load(); setOpen(false); resetForm()
    } catch (error) { setError(errorMessage(error)) } finally { setBusy(false) }
  }

  async function remove() {
    if (!deleting || busy) return
    setBusy(true); setError("")
    try { await api(`/api/voiceprints/${deleting.id}`, { method: "DELETE" }); await load(); setDeleting(null) }
    catch (error) { setError(errorMessage(error)) } finally { setBusy(false) }
  }

  const filteredRows = rows.filter((row) =>
    (!searchName.trim() || row.name.toLocaleLowerCase().includes(searchName.trim().toLocaleLowerCase())) &&
    (filterDepartment === "all" || row.department_id === filterDepartment)
  )
  const resetFilters = () => { setSearchName(""); setFilterDepartment("all") }

  return <section className="page-content animate-page-in">
    <div className="page-heading"><div><h1>声纹管理</h1></div>{!readOnly && <Button className="h-10 shrink-0 gap-2 px-4 shadow-sm" onClick={startCreate} disabled={!departments.length}><Plus className="size-4" />创建声纹</Button>}</div>
    {!readOnly && !departments.length && <p className="management-error" role="alert">请先创建部门，再录入声纹。</p>}
    {error && !open && <p className="management-error" role="alert">{error}</p>}
    <div className="voiceprint-filters" role="search" aria-label="筛选声纹">
      <div className="filter-field">
        <Label className="sr-only" htmlFor="voiceprint-search">姓名</Label>
        <div className="search-field"><Search className="size-4" /><Input id="voiceprint-search" placeholder="搜索姓名" value={searchName} onChange={(event) => setSearchName(event.target.value)} />{searchName && <button type="button" aria-label="清空姓名搜索" onClick={() => setSearchName("")}><X className="size-3.5" /></button>}</div>
      </div>
      <div className="filter-field">
        <Label className="sr-only" htmlFor="voiceprint-department-filter">部门</Label>
        <Select value={filterDepartment} onValueChange={setFilterDepartment}><SelectTrigger id="voiceprint-department-filter"><SelectValue placeholder="全部部门" /></SelectTrigger><SelectContent position="popper" side="bottom" align="start" sideOffset={4} avoidCollisions={false} className="meeting-filter-menu"><SelectItem value="all">全部部门</SelectItem>{departments.map((department) => <SelectItem key={department.id} value={department.id}>{department.name}</SelectItem>)}</SelectContent></Select>
      </div>
      <Button variant="ghost" onClick={resetFilters} disabled={!searchName && filterDepartment === "all"}>重置筛选</Button>
    </div>
    <Card className="meeting-table-card voiceprint-table-card gap-0 overflow-hidden rounded-xl py-0 shadow-none">
      <Table><TableHeader><TableRow className="bg-muted/45 hover:bg-muted/45"><TableHead>人员姓名</TableHead><TableHead>所属部门</TableHead><TableHead>录入类型</TableHead><TableHead>录音时长</TableHead><TableHead>创建时间</TableHead>{!readOnly && <TableHead className="operation-column"><span className="sr-only">操作</span></TableHead>}</TableRow></TableHeader><TableBody>
        {filteredRows.map((row) => <TableRow key={row.id} className="meeting-row"><TableCell><span className="voiceprint-person"><span className="voiceprint-avatar"><AudioLines className="size-4" /></span><strong>{row.name}</strong></span></TableCell><TableCell><span className="table-cell-value">{row.department_name || "未分类"}</span></TableCell><TableCell>{row.source === "recording" ? "在线" : "离线"}</TableCell><TableCell><span className="table-cell-value inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground"><Clock3 className="size-3.5 opacity-60" />{formatDuration(row.duration_seconds)}</span></TableCell><TableCell><span className="table-cell-value">{formatDate(row.created_at)}</span></TableCell>{!readOnly && <TableCell className="operation-column"><Button type="button" variant="ghost" size="icon-sm" aria-label={`删除${row.name}`} onClick={() => { setDeleting(row); setError("") }} disabled={busy}><Trash2 /></Button></TableCell>}</TableRow>)}
        {!filteredRows.length && <TableRow className="hover:bg-transparent"><TableCell colSpan={readOnly ? 5 : 6} className="whitespace-normal"><div className="empty-state"><div className="empty-illustration"><div><AudioLines /></div></div><h3>{rows.length ? "没有找到匹配的声纹" : "还没有声纹记录"}</h3><p>{rows.length ? "请调整姓名或部门筛选条件。" : "创建声纹后，会议转写会尝试显示登记的人员姓名。"}</p>{!readOnly && <Button variant={rows.length ? "outline" : "default"} onClick={rows.length ? resetFilters : startCreate} disabled={!rows.length && !departments.length}>{rows.length ? "重置筛选" : <><Plus />创建第一条声纹</>}</Button>}</div></TableCell></TableRow>}
      </TableBody></Table>
    </Card>
    <Dialog open={open} onOpenChange={closeCreate}><DialogContent id="voiceprint-create-dialog" className="create-dialog max-h-[90vh] gap-0 overflow-y-auto p-0 sm:max-w-[460px]"><form onSubmit={submit}>
      <div className="create-dialog-body px-7 pb-7 pt-8">
        <div className="mb-5 flex size-12 items-center justify-center rounded-2xl border border-neutral-100 bg-neutral-50 text-neutral-600"><AudioLines className="size-6" /></div>
        <DialogHeader className="text-left"><DialogTitle className="text-xl font-semibold tracking-tight">创建声纹</DialogTitle><DialogDescription className="mt-2 leading-6">录入人员姓名、部门和一段清晰的单人讲话音频。</DialogDescription></DialogHeader>
        <div className="mt-7 space-y-5">
          <div className="space-y-2.5"><Label htmlFor="voiceprint-name">人员姓名</Label><Input id="voiceprint-name" className="h-11" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="例如：张三" disabled={busy || recording} required /></div>
          <div className="space-y-2.5"><Label htmlFor="voiceprint-department">所属部门</Label><Select value={departmentId} onValueChange={setDepartmentId} disabled={busy || recording}><SelectTrigger id="voiceprint-department" className="h-11 w-full"><SelectValue placeholder="选择部门" /></SelectTrigger><SelectContent position="popper" side="bottom" align="start" sideOffset={4} avoidCollisions={false} className="meeting-filter-menu">{departments.map((department) => <SelectItem key={department.id} value={department.id}>{department.name}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-2.5"><Label>录入方式</Label><div className="voiceprint-source-tabs"><Button type="button" disabled={recording || busy} variant={mode === "recording" ? "secondary" : "ghost"} onClick={() => { setMode("recording"); setFile(null) }}><Mic />在线录音</Button><Button type="button" disabled={recording || busy} variant={mode === "import" ? "secondary" : "ghost"} onClick={() => { setMode("import"); setFile(null) }}><Upload />导入音频</Button></div></div>
          {mode === "recording" ? <div className="voiceprint-recorder"><Button type="button" variant={recording ? "destructive" : "default"} onClick={recording ? stopRecording : startRecording}>{recording ? <><Square />停止录音</> : <><Mic />开始录音</>}</Button>{file && !recording && <span>录音已就绪</span>}</div> : <Label className="voiceprint-upload-button"><Upload />选择音频文件<Input className="sr-only" type="file" accept="audio/wav,audio/mpeg,audio/mp4,audio/flac,audio/ogg" onChange={(event) => setFile(event.target.files?.[0] || null)} disabled={busy} /></Label>}
          {file && <p className="voiceprint-file">{file.name} · {(file.size / 1024).toFixed(0)} KB</p>}
        </div>
        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter className="m-0 border-t bg-muted/30 px-7 py-5 sm:justify-between"><Button type="button" variant="ghost" onClick={() => closeCreate(false)} disabled={busy || recording}>取消</Button><Button type="submit" disabled={busy || recording || !file || !name.trim() || !departmentId} className="gap-2 px-5">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <AudioLines className="size-4" />}保存声纹<ArrowRight className="size-4" /></Button></DialogFooter>
    </form></DialogContent></Dialog>
    <Dialog open={!!deleting} onOpenChange={(next) => { if (!next && !busy) { setDeleting(null); setError("") } }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>删除声纹</DialogTitle><DialogDescription>确认删除声纹「{deleting?.name}」？删除后将无法恢复。</DialogDescription></DialogHeader>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => { setDeleting(null); setError("") }}>取消</Button><Button disabled={busy} onClick={remove}>{busy && <LoaderCircle className="animate-spin" />}确认删除</Button></DialogFooter></DialogContent></Dialog>
  </section>
}
