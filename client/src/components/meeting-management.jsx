import { useEffect, useState } from "react";
import {
  Building2,
  FileText,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  EMPTY_FILTERS,
  MEETING_STATUS_LABELS,
  meetingQuery,
} from "@/services/meeting-catalog";

export function DepartmentSelect({
  departments,
  value,
  onChange,
  label = "所属部门",
  all = false,
  disabled = false,
}) {
  return (
    <Label className="form-field">
      <span>{label}</span>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label={label}>
          <SelectValue className="min-w-0" />
        </SelectTrigger>
        <SelectContent
          position="popper"
          side="bottom"
          align="start"
          sideOffset={4}
          avoidCollisions={false}
          className="meeting-filter-menu"
        >
          {all && <SelectItem value="all">全部部门</SelectItem>}
          <SelectItem value="unassigned">未分类</SelectItem>
          {departments.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Label>
  );
}

export function CreateMeetingDialog({
  open,
  onOpenChange,
  departments,
  loading,
  departmentError,
  onRefresh,
  onCreate,
  initialTitle = "",
}) {
  const [title, setTitle] = useState("");
  const [departmentId, setDepartmentId] = useState("unassigned");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      setTitle(initialTitle);
      setDepartmentId("unassigned");
      setError("");
    }
  }, [open, initialTitle]);
  async function submit(event) {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate(
        title.trim(),
        departmentId === "unassigned" ? null : departmentId,
      );
      onOpenChange(false);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent className="management-dialog">
        <form onSubmit={submit} className="management-form">
          <DialogHeader>
            <DialogTitle>新建会议</DialogTitle>
            <DialogDescription>
              填写会议名称并选择部门，创建后可开始录音。
            </DialogDescription>
          </DialogHeader>
          <Label className="form-field">
            <span>会议名称</span>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={80}
              required
              disabled={busy}
              placeholder="例如：产品研发周会"
            />
          </Label>
          <DepartmentSelect
            departments={departments}
            value={departmentId}
            onChange={setDepartmentId}
            disabled={busy || loading}
          />
          {departmentError ? (
            <div role="alert" className="management-error">
              {departmentError}
              <Button type="button" variant="ghost" onClick={onRefresh}>
                重试加载部门
              </Button>
            </div>
          ) : (
            !loading &&
            !departments.length && (
              <p className="management-help">
                可先在部门管理中添加部门，也可选择未分类。
              </p>
            )
          )}
          {error && (
            <p role="alert" className="management-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy || !title.trim()}>
              {busy && <LoaderCircle className="animate-spin" size={15} />}
              创建并进入
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MeetingManagement({
  api,
  departments,
  revision,
  onOpen,
  onCreate,
  onCurrent,
  hasCurrent,
  busy,
}) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState({
    key: "",
    meetings: [],
    error: "",
    loading: true,
  });

  let rangeError = "",
    query;
  try {
    query = meetingQuery(filters);
  } catch (error) {
    rangeError = error.message;
  }
  const key = JSON.stringify(query || {});
  useEffect(() => {
    if (!api || rangeError) return;
    const controller = new AbortController();
    setResult({ key, meetings: [], error: "", loading: true });
    const timer = setTimeout(async () => {
      try {
        const meetings = await api.list(filters, { signal: controller.signal });
        if (!controller.signal.aborted)
          setResult({ key, meetings, error: "", loading: false });
      } catch (error) {
        if (!controller.signal.aborted)
          setResult({
            key,
            meetings: [],
            error: error.message,
            loading: false,
          });
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, key, refresh, revision, rangeError]);
  const loading =
    !!api && !rangeError && (result.key !== key || result.loading);
  const error =
    rangeError ||
    (!api
      ? "请在模型设置中配置会议服务地址"
      : result.key === key
        ? result.error
        : "");
  const meetings =
    rangeError || !api ? [] : result.key === key ? result.meetings : [];
  const update = (patch) =>
    setFilters((previous) => ({ ...previous, ...patch }));
  const filtered = Object.keys(query || {}).length > 0;
  return (
    <section className="page-content management-page">
      <div className="page-heading">
        <div>
          <h1>会议管理</h1>
          <p>按部门、日期、状态和名称查找会议。</p>
        </div>
        <div className="heading-actions">
          <Button
            variant="outline"
            onClick={() => setRefresh((value) => value + 1)}
            disabled={loading}
          >
            <RefreshCw size={15} />
            刷新列表
          </Button>
          {hasCurrent && (
            <Button variant="outline" onClick={onCurrent}>
              当前会议
            </Button>
          )}
          <Button onClick={onCreate} disabled={busy}>
            <Plus size={15} />
            新建会议
          </Button>
        </div>
      </div>
      <div className="meeting-filters" role="search" aria-label="筛选会议">
        <Label className="form-field filter-title">
          <span>会议名称</span>
          <Input
            aria-label="搜索会议"
            placeholder="输入会议名称"
            maxLength={80}
            value={filters.title}
            onChange={(event) => update({ title: event.target.value })}
          />
        </Label>
        <DepartmentSelect
          departments={departments}
          all
          value={filters.departmentId}
          onChange={(departmentId) => update({ departmentId })}
        />
        <Label className="form-field">
          <span>会议状态</span>
          <Select
            value={filters.status}
            onValueChange={(status) => update({ status })}
          >
            <SelectTrigger aria-label="会议状态">
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              position="popper"
              side="bottom"
              align="start"
              sideOffset={4}
              avoidCollisions={false}
              className="meeting-filter-menu"
            >
              <SelectItem value="all">全部状态</SelectItem>
              {Object.entries(MEETING_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>
        <Label className="form-field">
          <span>开始日期</span>
          <Input
            type="date"
            title="开始日期"
            value={filters.startDate}
            onChange={(event) => update({ startDate: event.target.value })}
          />
        </Label>
        <Label className="form-field">
          <span>结束日期</span>
          <Input
            type="date"
            title="结束日期"
            value={filters.endDate}
            onChange={(event) => update({ endDate: event.target.value })}
          />
        </Label>
        <Button variant="outline" onClick={() => setFilters(EMPTY_FILTERS)}>
          重置筛选
        </Button>
      </div>
      {error && (
        <div role="alert" className="management-error">
          {error}
          {!rangeError && (
            <Button
              variant="ghost"
              onClick={() => setRefresh((value) => value + 1)}
            >
              重新加载
            </Button>
          )}
        </div>
      )}
      <Card className="history-table-card">
        <div
          className="history-table-scroll panel-scroll management-table"
          aria-busy={loading}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>会议名称</TableHead>
                <TableHead>所属部门</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>会议状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!loading &&
                !error &&
                meetings.map((meeting) => (
                  <TableRow key={meeting.id}>
                    <TableCell>
                      <button
                        className="meeting-title-button"
                        onClick={() => onOpen(meeting)}
                      >
                        <span className="table-document-icon">
                          <FileText size={17} />
                        </span>
                        <span>
                          <strong>{meeting.title}</strong>
                          <small>{meeting.text || "暂无转写内容"}</small>
                        </span>
                      </button>
                    </TableCell>
                    <TableCell>
                      <span className="department-name">
                        <Building2 size={13} />
                        {departments.find(
                          (item) => item.id === meeting.department_id,
                        )?.name ||
                          meeting.department_name ||
                          "未分类"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="cell-date">
                        {meeting.created_at
                          ? new Date(meeting.created_at).toLocaleDateString(
                              "zh-CN",
                            )
                          : "—"}
                        <small>
                          {meeting.created_at
                            ? new Date(meeting.created_at).toLocaleTimeString(
                                "zh-CN",
                                { hour: "2-digit", minute: "2-digit" },
                              )
                            : ""}
                        </small>
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          meeting.status === "recording" ? "default" : "outline"
                        }
                      >
                        {MEETING_STATUS_LABELS[meeting.status] ||
                          meeting.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              {(loading || error || !meetings.length) && (
                <TableRow>
                  <TableCell colSpan={4}>
                    <EmptyDocument
                      icon={loading ? LoaderCircle : Search}
                      title={
                        loading
                          ? "正在加载会议"
                          : error
                            ? "会议列表暂不可用"
                            : filtered
                              ? "没有找到匹配的会议"
                              : "还没有会议记录"
                      }
                      description={
                        loading
                          ? "正在读取会议服务中的记录。"
                          : error
                            ? "请检查筛选条件或服务连接后重试。"
                            : "新建会议，或调整筛选条件。"
                      }
                    >
                      {!loading && !error && filtered ? (
                        <Button
                          variant="outline"
                          onClick={() => setFilters(EMPTY_FILTERS)}
                        >
                          查看全部记录
                        </Button>
                      ) : null}
                    </EmptyDocument>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="document-footer">
          <span>{loading ? "查询中…" : `共 ${meetings.length} 场会议`}</span>
          <span>服务端保存</span>
        </div>
      </Card>
    </section>
  );
}
