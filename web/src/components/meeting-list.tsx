import {
  ArrowDown,
  ArrowRight,
  CalendarDays,
  Check,
  Clock3,
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MeetingStatusBadge } from "./meeting-status"
import { formatDate, formatDuration, type Meeting } from "@/lib/meetings"

export type MeetingFilter = "all" | "active" | "ended"
interface Props {
  meetings: Meeting[]
  loading: boolean
  filter: MeetingFilter
  onFilter: (filter: MeetingFilter) => void
  query: string
  onQuery: (query: string) => void
  onCreate: () => void
  onRefresh: () => void
}

export function MeetingList({
  meetings,
  loading,
  filter,
  onFilter,
  query,
  onQuery,
  onCreate,
  onRefresh,
}: Props) {
  const active = meetings.filter((meeting) => meeting.status !== "ended").length
  const minutes = Math.round(
    meetings.reduce((total, meeting) => total + meeting.duration_seconds, 0) / 60,
  )
  const filtered = meetings.filter((meeting) => {
    const matchesStatus =
      filter === "all" ||
      (filter === "active" ? meeting.status !== "ended" : meeting.status === "ended")
    return (
      matchesStatus &&
      `${meeting.title}\n${meeting.text}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase())
    )
  })
  const filteredEmpty = !!query || filter !== "all"

  return (
    <section id="list-view" className="page-content animate-page-in">
      <div className="page-heading">
        <div>
          <h1>会议记录</h1>
          <p>查看会议记录，或继续未结束的转写。</p>
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

      <div className="overview-strip">
        <div className="overview-item">
          <span className="overview-icon">
            <FileText />
          </span>
          <div>
            <p>全部会议</p>
            <div>
              <strong id="total-count">{meetings.length}</strong>
              <span>场会议</span>
            </div>
          </div>
        </div>
        <div className="overview-item">
          <span className="overview-icon">
            <Clock3 />
          </span>
          <div>
            <p>累计录音</p>
            <div>
              <strong>{minutes}</strong>
              <span>分钟</span>
            </div>
          </div>
        </div>
        <div className="overview-item">
          <span className="overview-icon">
            <CalendarDays />
          </span>
          <div>
            <p>待继续</p>
            <div>
              <strong id="active-count">{active}</strong>
              <span>场未结束</span>
            </div>
          </div>
        </div>
      </div>

      <div className="list-heading">
        <h2>
          会议列表 <span>{meetings.length}</span>
        </h2>
        <span className="sort-note">
          <ArrowDown className="size-3.5" />
          最近创建优先
        </span>
      </div>
      <div className="list-toolbar">
        <Tabs value={filter} onValueChange={(value) => onFilter(value as MeetingFilter)}>
          <TabsList className="h-9 bg-neutral-100/90 p-1">
            <TabsTrigger value="all" className="px-3.5 text-xs">
              全部会议
            </TabsTrigger>
            <TabsTrigger value="active" className="px-3.5 text-xs">
              未结束<span className="tab-count">{active}</span>
            </TabsTrigger>
            <TabsTrigger value="ended" className="px-3.5 text-xs">
              已结束
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="search-actions">
          <div className="search-field">
            <Search className="size-4" />
            <Input
              id="meeting-search"
              aria-label="搜索会议"
              placeholder="搜索会议名称或内容…"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
            />
            {query ? (
              <button onClick={() => onQuery("")} aria-label="清空搜索">
                <X className="size-3.5" />
              </button>
            ) : (
              <kbd>/</kbd>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                id="refresh-button"
                variant="outline"
                size="icon"
                aria-label="刷新会议记录"
                onClick={onRefresh}
                disabled={loading}
              >
                <RefreshCw className={loading ? "animate-spin" : ""} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>刷新会议记录</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <Card className="meeting-table-card gap-0 overflow-hidden rounded-xl py-0 shadow-none">
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
            {loading && meetings.length === 0
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
                  <MeetingStatusBadge status={meeting.status} />
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
                          <a href={`/api/meetings/${meeting.id}/download`}>
                            <FileText />
                            下载转写文本
                          </a>
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!loading && filtered.length === 0 && (
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
                onClick={() => {
                  onFilter("all")
                  onQuery("")
                }}
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
        )}
        <div className="table-footer">
          <span>
            {query ? `找到 ${filtered.length} 场相关会议` : `共 ${filtered.length} 场会议`}
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
