import { useState, type FormEvent } from "react"
import { Building2, LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, errorMessage, formatDate, type Department } from "@/lib/meetings"

export function DepartmentManagement({ departments, onChanged }: {
  departments: Department[]
  onChanged: () => Promise<void>
}) {
  const [editing, setEditing] = useState<Department | "new" | null>(null)
  const [deleting, setDeleting] = useState<Department | null>(null)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  function edit(department: Department | "new") {
    setEditing(department)
    setName(department === "new" ? "" : department.name)
    setError("")
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!editing || !name.trim() || busy) return
    setBusy(true)
    setError("")
    try {
      await api<Department>(editing === "new" ? "/api/departments" : `/api/departments/${editing.id}`, {
        method: editing === "new" ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      })
      await onChanged()
      setEditing(null)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!deleting || busy) return
    setBusy(true)
    setError("")
    try {
      await api<void>(`/api/departments/${deleting.id}`, { method: "DELETE" })
      await onChanged()
      setDeleting(null)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section id="departments-view" className="page-content animate-page-in">
      <div className="page-heading">
        <div>
          <h1>部门管理</h1>
          <p>维护会议所属部门，方便分类和查找记录。</p>
        </div>
        <Button id="create-department" className="h-10 shrink-0 gap-2" onClick={() => edit("new")}>
          <Plus className="size-4" />新增部门
        </Button>
      </div>
      <Card className="department-table-card gap-0 overflow-hidden rounded-xl py-0 shadow-none">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>部门名称</TableHead>
              <TableHead className="w-24">会议数</TableHead>
              <TableHead className="department-date-column w-36">创建时间</TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {departments.map((department) => (
              <TableRow key={department.id}>
                <TableCell><span className="department-name"><Building2 className="size-4 shrink-0 text-muted-foreground" />{department.name}</span></TableCell>
                <TableCell className="text-muted-foreground">{department.meeting_count}</TableCell>
                <TableCell className="department-date-column text-xs text-muted-foreground">{formatDate(department.created_at, false)}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label={`编辑${department.name}`} onClick={() => edit(department)}><Pencil /></Button>
                    <Button
                      variant="ghost" size="icon-sm" aria-label={`删除${department.name}`}
                      disabled={department.meeting_count > 0}
                      title={department.meeting_count > 0 ? "已有会议记录的部门不能删除" : "删除部门"}
                      onClick={() => { setDeleting(department); setError("") }}
                    ><Trash2 /></Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!departments.length && (
              <TableRow><TableCell colSpan={4}>
                <div className="empty-state">
                  <Building2 className="mb-4 size-8 text-neutral-400" />
                  <h3>还没有部门</h3>
                  <p>添加部门后，创建会议时即可选择归属。</p>
                  <Button variant="outline" onClick={() => edit("new")}><Plus />新增部门</Button>
                </div>
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        <div className="table-footer"><span>共 {departments.length} 个部门</span><span>已有会议的部门可重命名</span></div>
      </Card>
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !busy) setEditing(null) }}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={save} className="space-y-6">
            <DialogHeader>
              <DialogTitle>{editing === "new" ? "新增部门" : "编辑部门"}</DialogTitle>
              <DialogDescription>部门名称用于会议分类，重命名会同步更新关联会议。</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="department-name">部门名称</Label>
              <Input id="department-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：产品研发部" maxLength={60} required disabled={busy} />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(null)}>取消</Button>
              <Button type="submit" disabled={busy || !name.trim()}>{busy && <LoaderCircle className="animate-spin" />}保存部门</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!deleting} onOpenChange={(open) => { if (!open && !busy) setDeleting(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除部门</DialogTitle>
            <DialogDescription className="break-words">确认删除「{deleting?.name}」？删除后，创建会议时将不再显示该部门。</DialogDescription>
          </DialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>取消</Button>
            <Button disabled={busy} onClick={remove}>{busy && <LoaderCircle className="animate-spin" />}确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
