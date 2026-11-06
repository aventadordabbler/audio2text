import { useEffect, useState } from "react";
import {
  Building2,
  Check,
  ChevronDown,
  Clock3,
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
import { STT_LANGUAGE_OPTIONS } from "@/shared/defaults.js";
import {
  EMPTY_FILTERS,
  MEETING_STATUS_LABELS,
  meetingQuery,
  importStatusLabel,
} from "@/services/meeting-catalog";

function formatDuration(seconds = 0) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function CreateMeetingDialog({
  open,
  onOpenChange,
  departments,
  minutesFormats = [],
  voiceprints = [],
  loading,
  departmentError,
  onRefresh,
  onCreate,
  uploadProgress,
  initialTitle = "",
  initialLanguage = "auto",
}) {
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("recording");
  const [files, setFiles] = useState([]);
  const [language, setLanguage] = useState(initialLanguage);
  const [minutesFormatId, setMinutesFormatId] = useState("default");
  const [keySpeakerIds, setKeySpeakerIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      setTitle(initialTitle);
      setSource("recording");
      setFiles([]);
      setLanguage(initialLanguage);
      setMinutesFormatId(minutesFormats.find((item) => item.is_default)?.id || minutesFormats[0]?.id || "default");
      setKeySpeakerIds([]);
      setError("");
    }
  }, [open, initialTitle, initialLanguage]);
  async function submit(event) {
    event.preventDefault();
    if (!title.trim() || busy || (source === "wav" && !files.length)) return;
    setBusy(true);
    setError("");
    try {
      await onCreate(
        title.trim(),
        null,
        source === "wav" ? files : [],
        language,
        minutesFormatId,
        keySpeakerIds,
      );
      onOpenChange(false);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  const selectedKeySpeakers = voiceprints.filter((voiceprint) => keySpeakerIds.includes(voiceprint.id));
  const keySpeakerLabel = selectedKeySpeakers.length === 0
    ? "选择重点人员"
    : selectedKeySpeakers.length === 1
      ? selectedKeySpeakers[0].name
      : `已选择 ${selectedKeySpeakers.length} 人`;
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
              选择实时录音或导入已有 WAV/MP3，自动整理会议内容。
            </DialogDescription>
          </DialogHeader>
          <Label className="form-field">
            <span>创建方式</span>
            <Select value={source} onValueChange={setSource} disabled={busy}>
              <SelectTrigger aria-label="创建方式"><SelectValue /></SelectTrigger>
              <SelectContent
                position="popper"
                side="bottom"
                align="start"
                sideOffset={4}
                avoidCollisions={false}
                className="meeting-filter-menu"
              >
                <SelectItem value="recording">实时录音</SelectItem>
                <SelectItem value="wav">导入音频（WAV/MP3）</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          {source === "wav" && (
            <>
              <Label className="form-field">
                <span>音频文件</span>
                <Input type="file" multiple accept=".wav,.mp3,audio/wav,audio/x-wav,audio/mpeg" required disabled={busy}
                  onChange={(event) => {
                    const selected = Array.from(event.target.files || []);
                    setFiles(selected);
                    if (selected[0] && !title.trim()) setTitle(selected[0].name.replace(/\.(wav|mp3)$/i, "").slice(0, 80));
                  }} />
              </Label>
              <Label className="form-field">
                <span>转写语言</span>
                <Select value={language} onValueChange={setLanguage} disabled={busy}>
                  <SelectTrigger aria-label="转写语言"><SelectValue /></SelectTrigger>
                  <SelectContent
                    position="popper"
                    side="bottom"
                    align="start"
                    sideOffset={4}
                    avoidCollisions={false}
                    className="meeting-filter-menu"
                  >
                    {STT_LANGUAGE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Label>
              <p className="management-help">上传后自动转写、标注说话人并生成纪要，时长按音频计算。上传完成后可离开页面。</p>
            </>
          )}
          <Label className="form-field">
            <span>纪要格式</span>
            <Select value={minutesFormatId} onValueChange={setMinutesFormatId} disabled={busy}>
              <SelectTrigger aria-label="纪要格式"><SelectValue placeholder="选择纪要格式" /></SelectTrigger>
              <SelectContent position="popper" side="bottom" align="start" sideOffset={4} avoidCollisions={false} className="meeting-filter-menu">
                {minutesFormats.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Label>
          <div className="form-field">
            <span>重点人员（可选）</span>
            {voiceprints.length ? <details className="key-speaker-dropdown">
              <summary className="key-speaker-trigger" aria-label="选择重点人员">
                <span className={selectedKeySpeakers.length ? "" : "placeholder"}>{keySpeakerLabel}</span>
                <ChevronDown size={15} />
              </summary>
              <div className="key-speaker-menu" role="group" aria-label="重点人员选项">
                {voiceprints.map((voiceprint) => {
                  const selected = keySpeakerIds.includes(voiceprint.id);
                  return <button key={voiceprint.id} type="button" role="menuitemcheckbox" aria-checked={selected} className="key-speaker-menu-item" disabled={busy} onClick={() => setKeySpeakerIds((current) => selected ? current.filter((id) => id !== voiceprint.id) : [...current, voiceprint.id])}>
                    <span className={`key-speaker-check${selected ? " selected" : ""}`}>{selected && <Check size={12} />}</span>
                    <span className="key-speaker-menu-name">{voiceprint.name}</span>{voiceprint.department_name && <small>{voiceprint.department_name}</small>}
                  </button>;
                })}
              </div>
            </details> : <p className="management-help">暂无可选声纹，可直接创建会议。</p>}
          </div>
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
            <Button type="submit" disabled={busy || !title.trim() || (source === "wav" && !files.length)}>
              {busy && <LoaderCircle className="animate-spin" size={15} />}
              {source === "wav" ? (busy ? (uploadProgress ? `正在上传分片 ${uploadProgress.completed}/${uploadProgress.total}` : "正在上传并解析") : "上传并创建") : "创建并进入"}
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
      ? "请先配置会议服务地址"
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
          <p>按日期、状态和名称查找会议。</p>
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
                <TableHead>创建人</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>录音时长</TableHead>
                <TableHead>状态</TableHead>
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
                        </span>
                      </button>
                    </TableCell>
                    <TableCell>
                      <span className="department-name">
                        <Building2 size={13} />
                        <span className="table-cell-value">
                          {departments.find(
                            (item) => item.id === meeting.department_id,
                          )?.name ||
                            meeting.department_name ||
                            "未分类"}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="table-cell-value">
                        {meeting.creator_account || "—"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="table-cell-value">
                        {meeting.created_at
                          ? new Date(meeting.created_at).toLocaleString("zh-CN", {
                              year: "numeric",
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "—"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="table-cell-value inline-flex items-center gap-1.5 font-mono">
                        <Clock3 size={13} />
                        {formatDuration(meeting.duration_seconds)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          meeting.status === "recording" ? "default" : "outline"
                        }
                      >
                        {meeting.import_job && meeting.import_job.status !== "ready" ? importStatusLabel(meeting.import_job) : MEETING_STATUS_LABELS[meeting.status] || meeting.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              {(loading || error || !meetings.length) && (
                <TableRow>
                  <TableCell colSpan={6}>
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
      </Card>
    </section>
  );
}
