import { useState, type FormEvent } from "react"
import { ClipboardList, LoaderCircle, Pencil, Plus, Sparkles, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, errorMessage, formatDate, type MinutesFormat } from "@/lib/meetings"

export function MinutesFormatManagement({ formats, onChanged }: { formats: MinutesFormat[]; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<MinutesFormat | "new" | null>(null)
  const [deleting, setDeleting] = useState<MinutesFormat | null>(null)
  const [name, setName] = useState("")
  const [prompt, setPrompt] = useState("")
  const [generationRequirement, setGenerationRequirement] = useState("")
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState("")
  const visibleFormats = formats.filter((format) => !format.is_default)

  function edit(format: MinutesFormat | "new") {
    setEditing(format)
    setName(format === "new" ? "" : format.name)
    setPrompt(format === "new" ? "" : format.prompt)
    setGenerationRequirement("")
    setError("")
  }

  function previewPrompt(value: string) {
    const text = value.replace(/\s+/g, " ")
    return text.length > 15 ? `${text.slice(0, 15)}…` : text
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!editing || !name.trim() || !prompt.trim() || busy) return
    setBusy(true)
    setError("")
    try {
      await api<MinutesFormat>(editing === "new" ? "/api/minutes-formats" : `/api/minutes-formats/${editing.id}`, {
        method: editing === "new" ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), prompt: prompt.trim() }),
      })
      await onChanged()
      setEditing(null)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function generatePrompt() {
    if (!editing || editing !== "new" || !name.trim() || !generationRequirement.trim() || generating || busy) return
    setGenerating(true)
    setError("")
    try {
      const result = await api<{ prompt: string }>("/api/minutes-formats/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), requirement: generationRequirement.trim() }),
      })
      setPrompt(result.prompt || "")
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setGenerating(false)
    }
  }

  async function remove() {
    if (!deleting || busy) return
    setBusy(true)
    setError("")
    try {
      await api<void>(`/api/minutes-formats/${deleting.id}`, { method: "DELETE" })
      await onChanged()
      setDeleting(null)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section id="minutes-formats-view" className="page-content minutes-format-page animate-page-in">
      <div className="page-heading">
        <div><h1>纪要格式</h1></div>
        <Button className="minutes-format-add h-10 shrink-0 gap-2" onClick={() => edit("new")}><Plus className="size-4" />新增格式</Button>
      </div>
      <Card className="meeting-table-card minutes-format-card gap-0 overflow-hidden rounded-xl py-0 shadow-none">
        <Table className="minutes-format-table">
          <TableHeader><TableRow className="bg-muted/45 hover:bg-muted/45"><TableHead>会议类型</TableHead><TableHead>模板提示词</TableHead><TableHead>更新时间</TableHead><TableHead className="operation-column">操作</TableHead></TableRow></TableHeader>
          <TableBody>
            {visibleFormats.map((format) => (
              <TableRow key={format.id} className="meeting-row">
                <TableCell><span className="minutes-format-name"><ClipboardList className="size-4 shrink-0 text-muted-foreground" />{format.name}</span></TableCell>
                <TableCell><span className="minutes-format-prompt">{previewPrompt(format.prompt)}</span></TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatDate(format.updated_at, false)}</TableCell>
                <TableCell><div className="flex justify-center gap-1"><Button variant="ghost" size="icon-sm" aria-label={`编辑${format.name}`} onClick={() => edit(format)}><Pencil /></Button><Button variant="ghost" size="icon-sm" aria-label={`删除${format.name}`} disabled={format.is_default || format.meeting_count > 0} title={format.is_default ? "默认格式不能删除" : format.meeting_count > 0 ? "已有会议使用该格式" : "删除格式"} onClick={() => { setDeleting(format); setError("") }}><Trash2 /></Button></div></TableCell>
              </TableRow>
            ))}
            {!visibleFormats.length && <TableRow className="hover:bg-transparent"><TableCell colSpan={4}><div className="empty-state"><ClipboardList className="mb-4 size-8 text-neutral-400" /><h3>还没有纪要格式</h3><p>新增格式后，创建会议时即可选择。</p><Button variant="outline" onClick={() => edit("new")}><Plus />新增格式</Button></div></TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !busy && !generating) setEditing(null) }}>
        <DialogContent className="minutes-format-dialog">
          <form onSubmit={save} className="space-y-6">
            <DialogHeader><DialogTitle>{editing === "new" ? "新增纪要格式" : "编辑纪要格式"}</DialogTitle><DialogDescription>提示词会作为生成纪要时的模板指令，请明确输出结构和内容要求。</DialogDescription></DialogHeader>
            <div className="space-y-2"><Label htmlFor="minutes-format-name">格式名称</Label><Input id="minutes-format-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder="例如：项目评审会" required disabled={busy || generating} /></div>
            {editing === "new" && <div className="space-y-2 minutes-format-generator"><Label htmlFor="minutes-format-requirement">智能生成要求</Label><textarea id="minutes-format-requirement" value={generationRequirement} onChange={(event) => setGenerationRequirement(event.target.value)} maxLength={6000} disabled={busy || generating} rows={4} className="minutes-format-editor minutes-format-requirement" placeholder="例如：需要包含会议结论、待办事项、责任人和截止时间" /><Button type="button" variant="outline" onClick={() => void generatePrompt()} disabled={busy || generating || !name.trim() || !generationRequirement.trim()}>{generating ? <LoaderCircle className="animate-spin" /> : <Sparkles />}智能生成提示词</Button></div>}
            <div className="space-y-2"><Label htmlFor="minutes-format-prompt">模板提示词</Label><textarea id="minutes-format-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={20000} required disabled={busy || generating} rows={12} className="minutes-format-editor" placeholder="描述纪要标题、栏目和整理规则" /></div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter><Button type="button" variant="outline" disabled={busy || generating} onClick={() => setEditing(null)}>取消</Button><Button type="submit" disabled={busy || generating || !name.trim() || !prompt.trim()}>{busy && <LoaderCircle className="animate-spin" />}保存格式</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!deleting} onOpenChange={(open) => { if (!open && !busy) setDeleting(null) }}>
        <DialogContent className="minutes-format-dialog minutes-format-delete-dialog"><DialogHeader><DialogTitle>删除纪要格式</DialogTitle><DialogDescription>确认删除「{deleting?.name}」？删除后，创建会议时将不再显示该格式。</DialogDescription></DialogHeader>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button disabled={busy} onClick={remove}>{busy && <LoaderCircle className="animate-spin" />}确认删除</Button></DialogFooter></DialogContent>
      </Dialog>
    </section>
  )
}
