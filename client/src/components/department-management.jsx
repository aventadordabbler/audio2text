import { useState } from "react";
import {
  Building2,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyDocument } from "@/components/workspace-ui";

export function DepartmentManagement({
  api,
  departments,
  loading,
  error,
  onChanged,
}) {
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  function edit(item) {
    setEditing(item);
    setName(item.name || "");
    setFormError("");
  }
  async function save(event) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setFormError("");
    try {
      await api.saveDepartment(name, editing.id);
      setEditing(null);
      onChanged();
    } catch (error) {
      setFormError(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (busy) return;
    setBusy(true);
    setFormError("");
    try {
      await api.deleteDepartment(deleting.id);
      setDeleting(null);
      onChanged();
    } catch (error) {
      setFormError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="page-content management-page">
      <div className="page-heading">
        <div>
          <h1>部门管理</h1>
          <p>维护会议所属部门，方便分类和查找。</p>
        </div>
        <div className="heading-actions">
          <Button variant="outline" onClick={onChanged} disabled={loading}>
            <RefreshCw size={14} />
            刷新
          </Button>
          <Button onClick={() => edit({})} disabled={!api || loading}>
            <Plus size={15} />
            新增部门
          </Button>
        </div>
      </div>
      {(error || !api) && (
        <div role="alert" className="management-error">
          {error || "请在模型设置中配置会议服务地址。"}
        </div>
      )}
      <Card className="history-table-card">
        <div className="history-table-scroll panel-scroll department-table">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>部门名称</TableHead>
                <TableHead>会议数</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {departments.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <span className="department-name">
                      <Building2 size={15} />
                      {item.name}
                    </span>
                  </TableCell>
                  <TableCell>{item.meeting_count}</TableCell>
                  <TableCell>
                    <span className="cell-date">
                      {new Date(item.created_at).toLocaleDateString("zh-CN")}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="heading-actions">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`编辑部门：${item.name}`}
                        onClick={() => edit(item)}
                      >
                        <Pencil size={15} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`删除部门：${item.name}`}
                        disabled={item.meeting_count > 0}
                        title={
                          item.meeting_count > 0
                            ? "该部门已有会议，不能删除"
                            : "删除部门"
                        }
                        onClick={() => {
                          setDeleting(item);
                          setFormError("");
                        }}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!departments.length && (
                <TableRow>
                  <TableCell colSpan={4}>
                    <EmptyDocument
                      icon={loading ? LoaderCircle : Building2}
                      title={
                        loading
                          ? "正在加载部门"
                          : error
                            ? "部门加载失败"
                            : "还没有部门"
                      }
                      description="新增部门后，创建会议时即可选择归属。"
                    />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="document-footer">
          <span>共 {departments.length} 个部门</span>
          <span>已有会议的部门可重命名</span>
        </div>
      </Card>
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open && !busy) setEditing(null);
        }}
      >
        <DialogContent className="management-dialog">
          <form className="management-form" onSubmit={save}>
            <DialogHeader>
              <DialogTitle>{editing?.id ? "编辑部门" : "新增部门"}</DialogTitle>
              <DialogDescription>
                重命名会同步更新所属会议中的部门名称。
              </DialogDescription>
            </DialogHeader>
            <Label className="form-field">
              <span>部门名称</span>
              <Input
                required
                maxLength={60}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
                placeholder="例如：产品研发部"
              />
            </Label>
            {formError && (
              <p role="alert" className="management-error">
                {formError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditing(null)}
                disabled={busy}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy && <LoaderCircle size={14} className="animate-spin" />}
                保存部门
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除部门</DialogTitle>
            <DialogDescription>
              确认删除「{deleting?.name}」？
            </DialogDescription>
          </DialogHeader>
          {formError && (
            <p role="alert" className="management-error">
              {formError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              取消
            </Button>
            <Button disabled={busy} onClick={remove}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
