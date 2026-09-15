import { AudioLines, CheckCheck, Clock3, FileText, FolderClosed, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import type { Meeting } from "@/lib/meetings"
import type { MeetingFilter } from "./meeting-list"

interface Props {
  meetings: Meeting[]
  filter: MeetingFilter
  inMeeting: boolean
  busy: boolean
  onFilter: (filter: MeetingFilter) => void
  onConfigure: () => void
  onNavigate?: () => void
}

export function WorkspaceSidebar({
  meetings,
  filter,
  inMeeting,
  busy,
  onFilter,
  onConfigure,
  onNavigate,
}: Props) {
  const active = meetings.filter((meeting) => meeting.status !== "ended").length
  const navigation = [
    { value: "all" as const, label: "会议记录", icon: FolderClosed, count: meetings.length },
    { value: "active" as const, label: "未结束的会议", icon: Clock3, count: active },
    {
      value: "ended" as const,
      label: "已结束的会议",
      icon: CheckCheck,
      count: meetings.length - active,
    },
  ]
  return (
    <div className="sidebar-content">
      <a
        className="workspace-brand"
        href="#"
        onClick={(event) => {
          if (busy) event.preventDefault()
          else onNavigate?.()
        }}
      >
        <span>
          <AudioLines />
        </span>
        <div>
          <strong>会议助手</strong>
          <small>会议与转写</small>
        </div>
      </a>
      <div className="sidebar-section-label">工作空间</div>
      <nav aria-label="会议导航" className="workspace-nav">
        {navigation.map(({ value, label, icon: Icon, count }) => (
          <button
            key={value}
            disabled={busy}
            className={cn("nav-item", !inMeeting && filter === value && "selected")}
            onClick={() => {
              onFilter(value)
              onNavigate?.()
            }}
          >
            <Icon className="size-4" />
            <span>{label}</span>
            <small>{count}</small>
          </button>
        ))}
      </nav>
      <Separator className="my-6" />
      <div className="sidebar-section-label">最近会议</div>
      <div className="recent-meetings">
        {meetings.length ? (
          meetings.slice(0, 4).map((meeting) => (
            <a
              href={`#meeting/${meeting.id}`}
              key={meeting.id}
              onClick={(event) => {
                if (busy) event.preventDefault()
                else onNavigate?.()
              }}
            >
              <FileText className="size-3.5 shrink-0" />
              <span>{meeting.title}</span>
              {meeting.status === "recording" && (
                <i className="size-1.5 rounded-full bg-neutral-500" />
              )}
            </a>
          ))
        ) : (
          <p>暂无会议记录</p>
        )}
      </div>
      <div className="sidebar-bottom">
        <Button
          variant="ghost"
          onClick={onConfigure}
          className="h-9 w-full justify-start gap-2 text-muted-foreground"
        >
          <Settings2 className="size-3.5" />
          模型配置
        </Button>
      </div>
    </div>
  )
}
