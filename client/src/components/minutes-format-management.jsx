import { useState } from "react";
import { ClipboardList, LoaderCircle, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyDocument } from "@/components/workspace-ui";

export function MinutesFormatManagement({ api, formats, onChanged }) {
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [generationRequirement, setGenerationRequirement] = useState("");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const visibleFormats = formats.filter((item) => !item.is_default);
  function edit(item) { setEditing(item); setName(item.name || ""); setPrompt(item.prompt || ""); setGenerationRequirement(""); setError(""); }
  function previewPrompt(value) {
    const text = String(value || "").replace(/\s+/g, " ");
    return text.length > 15 ? `${text.slice(0, 15)}…` : text;
  }
  async function save(event) {
    event.preventDefault();
    if (busy || !name.trim() || !prompt.trim()) return;
    setBusy(true); setError("");
    try { await api.saveMinutesFormat(name, prompt, editing.id); setEditing(null); onChanged(); }
    catch (saveError) { setError(saveError.message); }
    finally { setBusy(false); }
  }
  async function generatePrompt() {
    if (busy || generating || !api || !name.trim() || !generationRequirement.trim()) return;
    setGenerating(true); setError("");
    try {
      const result = await api.generateMinutesFormatPrompt(name, generationRequirement);
      setPrompt(result.prompt || "");
    } catch (generateError) {
      setError(generateError.message);
    } finally {
      setGenerating(false);
    }
  }
  async function remove() {
    if (busy) return;
    setBusy(true); setError("");
    try { await api.deleteMinutesFormat(deleting.id); setDeleting(null); onChanged(); }
    catch (removeError) { setError(removeError.message); }
    finally { setBusy(false); }
  }
  return <section className="page-content minutes-format-page animate-page-in">
    <div className="page-heading"><div><h1>纪要格式</h1></div><div className="heading-actions"><Button className="minutes-format-add h-10 shrink-0 gap-2" onClick={() => edit({})} disabled={!api}><Plus size={15} />新增格式</Button></div></div>
    {!api && <div role="alert" className="management-error">请先配置会议服务地址。</div>}
    <Card className="history-table-card"><div className="history-table-scroll panel-scroll management-table minutes-format-list"><Table className="minutes-format-table"><TableHeader><TableRow><TableHead>会议类型</TableHead><TableHead>模板提示词</TableHead><TableHead>更新时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
      {visibleFormats.map((item) => <TableRow key={item.id}><TableCell><span className="minutes-format-name"><ClipboardList size={15} />{item.name}</span></TableCell><TableCell><span className="minutes-format-prompt">{previewPrompt(item.prompt)}</span></TableCell><TableCell>{new Date(item.updated_at).toLocaleDateString("zh-CN")}</TableCell><TableCell><div className="heading-actions minutes-format-actions"><Button variant="ghost" size="icon" aria-label={`编辑${item.name}`} onClick={() => edit(item)}><Pencil size={15} /></Button><Button variant="ghost" size="icon" aria-label={`删除${item.name}`} disabled={item.meeting_count > 0} title={item.meeting_count > 0 ? "已有会议使用该格式" : "删除格式"} onClick={() => { setDeleting(item); setError(""); }}><Trash2 size={15} /></Button></div></TableCell></TableRow>)}
      {!visibleFormats.length && <TableRow><TableCell colSpan={4}><EmptyDocument icon={ClipboardList} title="还没有纪要格式" description="新增格式后，创建会议时即可选择。" /></TableCell></TableRow>}
    </TableBody></Table></div></Card>
    <Dialog open={!!editing} onOpenChange={(open) => { if (!open && !busy && !generating) setEditing(null); }}><DialogContent className="minutes-format-dialog"><form className="management-form" onSubmit={save}><DialogHeader><DialogTitle>{editing?.id ? "编辑纪要格式" : "新增纪要格式"}</DialogTitle><DialogDescription>提示词会作为生成纪要时的模板指令，请明确输出结构和内容要求。</DialogDescription></DialogHeader><Label className="form-field"><span>格式名称</span><Input required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} disabled={busy || generating} placeholder="例如：项目评审会" /></Label>{!editing?.id && <div className="form-field minutes-format-generator"><span>智能生成要求</span><textarea className="minutes-format-requirement" rows={4} maxLength={6000} value={generationRequirement} onChange={(event) => setGenerationRequirement(event.target.value)} disabled={busy || generating} placeholder="例如：需要包含会议结论、待办事项、责任人和截止时间" /><Button type="button" variant="outline" onClick={() => void generatePrompt()} disabled={busy || generating || !name.trim() || !generationRequirement.trim()}>{generating ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />}智能生成提示词</Button></div>}<Label className="form-field"><span>模板提示词</span><textarea required maxLength={20000} rows={12} value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={busy || generating} placeholder="描述纪要标题、栏目和整理规则" /></Label>{error && <p role="alert" className="management-error">{error}</p>}<DialogFooter><Button type="button" variant="outline" disabled={busy || generating} onClick={() => setEditing(null)}>取消</Button><Button type="submit" disabled={busy || generating || !name.trim() || !prompt.trim()}>{busy && <LoaderCircle size={14} className="animate-spin" />}保存格式</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={!!deleting} onOpenChange={(open) => { if (!open && !busy) setDeleting(null); }}><DialogContent className="minutes-format-dialog minutes-format-delete-dialog"><DialogHeader><DialogTitle>删除纪要格式</DialogTitle><DialogDescription>确认删除「{deleting?.name}」？删除后，创建会议时将不再显示该格式。</DialogDescription></DialogHeader>{error && <p role="alert" className="management-error">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button disabled={busy} onClick={remove}>{busy && <LoaderCircle size={14} className="animate-spin" />}确认删除</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
