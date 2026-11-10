import { AudioLines, Building2, ClipboardList, FileText, FolderClosed, MicVocal, Settings2, SlidersHorizontal, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import type { Meeting } from "@/lib/meetings"

interface Props {
  meetings: Meeting[]
  page: "meetings" | "departments" | "users" | "voiceprints" | "minutes-formats" | "system-settings"
  busy: boolean
  isAdmin: boolean
  canViewVoiceprints: boolean
  onPage: (page: "meetings" | "departments" | "users" | "voiceprints" | "minutes-formats" | "system-settings") => void
  onConfigure: () => void
  onNavigate?: () => void
}

export function WorkspaceSidebar({
  meetings,
  page,
  busy,
  onPage,
  onConfigure,
  onNavigate,
  isAdmin,
  canViewVoiceprints,
}: Props) {
  const navigation = [
    { value: "meetings" as const, label: "会议管理", icon: FolderClosed },
    ...(isAdmin ? [{ value: "departments" as const, label: "部门管理", icon: Building2 }] : []),
    ...(isAdmin ? [{ value: "users" as const, label: "用户管理", icon: Users }] : []),
    ...(canViewVoiceprints ? [{ value: "voiceprints" as const, label: "声纹管理", icon: MicVocal }] : []),
    ...(isAdmin ? [{ value: "minutes-formats" as const, label: "纪要格式", icon: ClipboardList }] : []),
    ...(isAdmin ? [{ value: "system-settings" as const, label: "系统管理", icon: SlidersHorizontal }] : []),
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
        {navigation.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            disabled={busy}
            className={cn("nav-item", page === value && "selected")}
            aria-current={page === value ? "page" : undefined}
            onClick={() => {
              onPage(value)
              onNavigate?.()
            }}
          >
            <Icon className="size-4" />
            <span>{label}</span>
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
      {isAdmin && (
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
      )}
    </div>
  )
}
