import { useEffect, useState } from "react"
import {
  ArrowRight,
  AudioLines,
  Check,
  Clock3,
  Download,
  FileText,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { MeetingStatusBadge } from "./meeting-status"
import { downloadRecording } from "@/lib/recording-download"
import { api, authToken, emptyMeetingFilters, errorMessage, formatDate, formatDuration, statusLabels, importStatusLabel, type Meeting, type MeetingFilters, type MeetingStatus } from "@/lib/meetings"

interface Props {
  meetings: Meeting[]
  loading: boolean
  filters: MeetingFilters
  onFilters: (filters: MeetingFilters) => void
  onCreate: () => void
  onRefresh: () => void
}

export function MeetingList({
  meetings,
  loading: loadingAll,
  filters,
  onFilters,
  onCreate,
  onRefresh,
}: Props) {
  const [exportError, setExportError] = useState("")
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [result, setResult] = useState<{ key: string; source: Meeting[]; meetings: Meeting[]; error: string } | null>(null)
  const params = new URLSearchParams()
  if (filters.title.trim()) params.set("title", filters.title.trim())
  if (filters.departmentId !== "all") params.set("department_id", filters.departmentId)
  if (filters.status !== "all") params.set("status", filters.status)
  if (filters.startDate) params.set("created_from", new Date(`${filters.startDate}T00:00:00`).toISOString())
  if (filters.endDate) {
    const end = new Date(`${filters.endDate}T00:00:00`)
    end.setDate(end.getDate() + 1)
    params.set("created_before", end.toISOString())
  }
  const searchKey = params.toString()
  const rangeError = filters.startDate && filters.endDate && filters.startDate > filters.endDate
    ? "开始日期不能晚于结束日期。" : ""
  const currentResult = result?.key === searchKey && result.source === meetings ? result : null
  const loading = loadingAll || (!!searchKey && !rangeError && !currentResult)
  const searchError = rangeError || currentResult?.error
  const filtered = rangeError ? [] : searchKey ? currentResult?.meetings || [] : meetings
  const filteredEmpty = !!searchKey

  useEffect(() => {
    if (!searchKey || rangeError) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const found = await api<Meeting[]>(`/api/meetings?${searchKey}`, { signal: controller.signal })
        if (!controller.signal.aborted) setResult({ key: searchKey, source: meetings, meetings: found, error: "" })
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key: searchKey, source: meetings, meetings: [], error: errorMessage(error) })
      }
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [searchKey, rangeError, meetings])

  function update(patch: Partial<MeetingFilters>) {
    onFilters({ ...filters, ...patch })
  }

  async function exportAudio(id: string) {
    if (exportingId) return
    setExportingId(id)
    setExportError("")
    try {
      await downloadRecording(id)
    } catch (error) {
      setExportError(`导出录音失败：${errorMessage(error)}`)
    } finally {
      setExportingId(null)
    }
  }

  const active = meetings.filter((meeting) => meeting.status !== "ended").length
  const minutes = Math.round(
    meetings.reduce((total, meeting) => total + meeting.duration_seconds, 0) / 60,
  )

  return (
    <section id="list-view" className="page-content animate-page-in">
      {exportError && <p role="alert" className="text-destructive mb-3">{exportError}</p>}
      <div className="page-heading meeting-list-heading">
        <div className="meeting-title-summary">
          <h1>会议管理</h1>
          <dl className="meeting-stats" aria-label="会议统计">
            <div>
              <dt><span className="meeting-stat-icon"><FileText aria-hidden="true" /></span>全部会议</dt>
              <dd><strong id="total-count">{meetings.length}</strong><span>场</span></dd>
            </div>
            <div>
              <dt><span className="meeting-stat-icon"><AudioLines aria-hidden="true" /></span>累计录音</dt>
              <dd><strong>{minutes}</strong><span>分钟</span></dd>
            </div>
            <div>
              <dt><span className="meeting-stat-icon"><Clock3 aria-hidden="true" /></span>未结束</dt>
              <dd><strong id="active-count">{active}</strong><span>场</span></dd>
            </div>
          </dl>
        </div>
        <Button
          id="create-button"
          onClick={onCreate}
          className="h-10 shrink-0 gap-2 px-4 shadow-sm"
        >
          <Plus className="size-4" />
          创建会议
        </Button>
      </div>

      <div className="list-heading">
        <h2>
          会议列表 <span>{meetings.length}</span>
        </h2>
      </div>
      <div className="meeting-filters" aria-label="会议筛选">
        <div className="filter-field filter-title">
          <Label htmlFor="meeting-search" className="sr-only">会议名称</Label>
          <div className="search-field">
            <Search className="size-4" />
            <Input
              id="meeting-search"
              placeholder="搜索会议名称…"
              maxLength={80}
              value={filters.title}
              onChange={(event) => update({ title: event.target.value })}
            />
            {filters.title ? (
              <button onClick={() => update({ title: "" })} aria-label="清空搜索">
                <X className="size-3.5" />
              </button>
            ) : (
              <kbd>/</kbd>
            )}
          </div>
        </div>
        <div className="filter-field">
          <Label htmlFor="filter-status" className="sr-only">会议状态</Label>
          <Select value={filters.status} onValueChange={(status) => update({ status: status as MeetingStatus | "all" })}>
            <SelectTrigger id="filter-status"><SelectValue /></SelectTrigger>
            <SelectContent
              position="popper"
              side="bottom"
              align="start"
              sideOffset={4}
              avoidCollisions={false}
              className="meeting-filter-menu"
            >
              <SelectItem value="all">全部状态</SelectItem>
              {Object.entries(statusLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="filter-field">
          <Label htmlFor="filter-start-date" className="sr-only">创建日期 · 从</Label>
          <Input id="filter-start-date" type="date" title="创建开始日期" value={filters.startDate} max={filters.endDate || undefined} onChange={(e) => update({ startDate: e.target.value })} />
        </div>
        <div className="filter-field">
          <Label htmlFor="filter-end-date" className="sr-only">创建日期 · 至</Label>
          <Input id="filter-end-date" type="date" title="创建结束日期" value={filters.endDate} min={filters.startDate || undefined} onChange={(e) => update({ endDate: e.target.value })} />
        </div>
        <div className="filter-actions">
          <Button variant="ghost" onClick={() => onFilters(emptyMeetingFilters)} disabled={!filteredEmpty}>重置筛选</Button>
          <Button id="refresh-button" variant="outline" aria-label="刷新会议记录" onClick={onRefresh} disabled={loading}>
            <RefreshCw className={loading ? "animate-spin" : ""} />刷新
          </Button>
        </div>
        {searchError && <p role="alert" className="filter-error">{searchError}</p>}
      </div>
      <Card className="meeting-table-card gap-0 overflow-hidden rounded-xl py-0 shadow-none" aria-busy={loading}>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/45 hover:bg-muted/45">
              <TableHead className="pl-6">会议名称</TableHead>
              <TableHead className="date-column">创建时间</TableHead>
              <TableHead className="duration-column">录音时长</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-14">
                <span className="sr-only">操作</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody id="meeting-list">
            {loading && filtered.length === 0
              ? Array.from({ length: 4 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell className="py-6 pl-6">
                      <Skeleton className="mb-2 h-4 w-40" />
                      <Skeleton className="h-3 w-56" />
                    </TableCell>
                    <TableCell className="date-column">
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                    <TableCell className="duration-column">
                      <Skeleton className="h-4 w-12" />
                    </TableCell>
                    <TableCell colSpan={2}>
                      <Skeleton className="h-5 w-16" />
                    </TableCell>
                  </TableRow>
                ))
              : null}
            {filtered.map((meeting) => (
              <TableRow key={meeting.id} className="meeting-row group">
                <TableCell className="meeting-name-cell pl-6">
                  <a href={`#meeting/${meeting.id}`} className="meeting-entry">
                    <span
                      className={`document-icon ${meeting.status === "recording" ? "is-live" : ""}`}
                    >
                      <FileText className="size-[18px]" />
                    </span>
                    <span className="meeting-summary">
                      <strong>{meeting.title}</strong>
                      <span className="meeting-department">{meeting.department_name || "未分类"}</span>
                      <span className="meeting-preview">
                        {meeting.text ||
                          (meeting.status === "created"
                            ? "一切准备就绪，等待开始录音"
                            : "暂无转写内容")}
                      </span>
                      <span className="mobile-date">{formatDate(meeting.created_at, false)}</span>
                    </span>
                  </a>
                </TableCell>
                <TableCell className="date-column">
                  <div className="cell-date">
                    {formatDate(meeting.created_at, false)}
                    <span>
                      {new Date(meeting.created_at).toLocaleTimeString("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="duration-column">
                  <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                    <Clock3 className="size-3.5 opacity-60" />
                    {formatDuration(meeting.duration_seconds)}
                  </span>
                </TableCell>
                <TableCell>
                  {meeting.import_job && meeting.import_job.status !== "ready"
                    ? <span className="text-xs text-muted-foreground">{importStatusLabel(meeting.import_job)}</span>
                    : <MeetingStatusBadge status={meeting.status} />}
                </TableCell>
                <TableCell className="pr-4">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`${meeting.title}的操作`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <a href={`#meeting/${meeting.id}`}>
                          <ArrowRight />
                          {meeting.status === "ended" ? "查看会议记录" : "进入会议"}
                        </a>
                      </DropdownMenuItem>
                      {meeting.text && (
                        <DropdownMenuItem asChild>
                          <a href={`/api/meetings/${meeting.id}/download?token=${encodeURIComponent(authToken())}`}>
                            <FileText />
                            导出文本（TXT）
                          </a>
                        </DropdownMenuItem>
                      )}
                      {meeting.audio_available && (
                        <DropdownMenuItem disabled={exportingId !== null} onSelect={() => void exportAudio(meeting.id)}>
                          <Download />
                          导出录音（WAV）
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
            {!loading && !searchError && filtered.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="whitespace-normal">
                  <div className="empty-state">
                    <div className="empty-illustration">
                      <span />
                      <span />
                      <div>{filteredEmpty ? <Search /> : <FileText />}</div>
                    </div>
                    <h3>{filteredEmpty ? "没有找到符合条件的会议" : "从第一场会议开始"}</h3>
                    <p>
                      {filteredEmpty
                        ? "换个关键词，或查看全部会议记录。"
                        : "创建一场会议，专注交流，让想法自然被记录。"}
                    </p>
                    {filteredEmpty ? (
                      <Button
                        variant="outline"
                        onClick={() => onFilters(emptyMeetingFilters)}
                      >
                        查看全部会议
                      </Button>
                    ) : (
                      <Button onClick={onCreate}>
                        <Plus />
                        创建第一场会议
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <div className="table-footer">
          <span>
            {loading ? "正在读取会议…" : searchError ? "查询未完成" : filteredEmpty ? `找到 ${filtered.length} 场相关会议` : `共 ${filtered.length} 场会议`}
          </span>
          <span>
            <Check className="size-3.5" />
            会议内容自动保存
          </span>
        </div>
      </Card>
    </section>
  )
}
