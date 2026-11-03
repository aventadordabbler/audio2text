import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { AlertCircle, CalendarDays, ChevronRight, Menu, PanelsTopLeft, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CreateMeetingDialog } from "@/components/create-meeting-dialog"
import { DepartmentManagement } from "@/components/department-management"
import { MeetingDetail } from "@/components/meeting-detail"
import { ModelConfigDialog } from "@/components/model-config-dialog"
import { MeetingList } from "@/components/meeting-list"
import { WorkspaceSidebar } from "@/components/workspace-sidebar"
import { AuthScreen } from "@/components/auth-screen"
import { api, authToken, emptyMeetingFilters, errorMessage, setAuthToken, type Department, type Meeting, type MeetingFilters } from "@/lib/meetings"
import { RecordingSession } from "@/lib/recording-session"

export default function App() {
  const [session] = useState(() => new RecordingSession())
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const [authReady, setAuthReady] = useState(false)
  const [authUser, setAuthUser] = useState<Record<string, string> | null>(null)
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [loading, setLoading] = useState(true)
  const [routing, setRouting] = useState(true)
  const [filters, setFilters] = useState<MeetingFilters>(emptyMeetingFilters)
  const [departments, setDepartments] = useState<Department[]>([])
  const [page, setPage] = useState<"meetings" | "departments">("meetings")
  const [error, setError] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(false)
  const [modelsVersion, setModelsVersion] = useState(0)

  useEffect(() => {
    const expired = () => setAuthUser(null)
    window.addEventListener("auth-expired", expired)
    if (!authToken()) {
      setAuthReady(true)
    } else {
      void api<Record<string, string>>("/api/auth/me")
        .then(setAuthUser)
        .catch(() => setAuthToken(null))
        .finally(() => setAuthReady(true))
    }
    return () => window.removeEventListener("auth-expired", expired)
  }, [])

  const refresh = useCallback(async () => {
    if (!authUser) return
    setLoading(true)
    try {
      const [meetings, departments] = await Promise.all([
        api<Meeting[]>("/api/meetings"), api<Department[]>("/api/departments"),
      ])
      setMeetings(meetings)
      setDepartments(departments)
      setFilters((filters) =>
        filters.departmentId === "all" || filters.departmentId === "unassigned" || departments.some((department) => department.id === filters.departmentId)
          ? filters : { ...filters, departmentId: "all" },
      )
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [authUser])

  useEffect(() => {
    let active = true
    if (!authUser) {
      setRouting(false)
      return () => { active = false }
    }
    let queue = Promise.resolve()
    const navigate = () => {
      queue = queue
        .then(async () => {
          setRouting(true)
          await session.leave()
          setError("")
          const match = location.hash.match(/^#meeting\/([a-f0-9]{32})$/)
          if (active) setPage(location.hash === "#departments" ? "departments" : "meetings")
          try {
            if (match) {
              const meeting = await api<Meeting>(`/api/meetings/${match[1]}`)
              if (active) session.enter(meeting)
            }
            if (active) await refresh()
          } catch (error) {
            if (active) setError(errorMessage(error))
          } finally {
            if (active) setRouting(false)
          }
        })
        .catch((error) => {
          if (active) {
            setError(errorMessage(error))
            setRouting(false)
          }
        })
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (session.shouldWarnBeforeLeave()) {
        event.preventDefault()
        event.returnValue = ""
      }
    }
    const searchShortcut = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        (event.target instanceof HTMLElement &&
          (event.target.matches("input, textarea, select") || event.target.isContentEditable))
      )
        return
      const input = document.querySelector<HTMLInputElement>("#meeting-search")
      if (input && !document.querySelector("[role='dialog']")) {
        event.preventDefault()
        input.focus()
      }
    }
    window.addEventListener("hashchange", navigate)
    window.addEventListener("beforeunload", beforeUnload)
    window.addEventListener("keydown", searchShortcut)
    navigate()
    return () => {
      active = false
      window.removeEventListener("hashchange", navigate)
      window.removeEventListener("beforeunload", beforeUnload)
      window.removeEventListener("keydown", searchShortcut)
      session.disconnect()
    }
  }, [authUser, session, refresh])

  useEffect(() => {
    if (state.meeting)
      setMeetings((meetings) =>
        meetings.map((meeting) => (meeting.id === state.meeting!.id ? state.meeting! : meeting)),
      )
  }, [state.meeting])

  function selectPage(value: "meetings" | "departments") {
    location.hash = value === "departments" ? "departments" : ""
  }
  function created(meeting: Meeting) {
    setMeetings((meetings) => [meeting, ...meetings])
    location.hash = `meeting/${meeting.id}`
  }
  const configureModels = useCallback(() => {
    setMobileOpen(false)
    setModelsOpen(true)
  }, [])
  const sidebarProps = {
    meetings,
    page,
    busy: state.busy,
    onConfigure: configureModels,
    onPage: selectPage,
  }
  const visibleError = error || state.error

  if (!authReady) return <div className="auth-screen">正在检查登录状态…</div>
  if (!authUser) return <AuthScreen onAuthenticated={setAuthUser} />

  return (
    <TooltipProvider delayDuration={300}>
      <div className="app-layout">
        <aside className="desktop-sidebar">
          <WorkspaceSidebar {...sidebarProps} />
        </aside>
        <main className="main-workspace">
          <header className="workspace-topbar">
            <div className="flex min-w-0 items-center gap-3">
              <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                <SheetTrigger asChild>
                  <Button
                    className="mobile-menu"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="打开导航"
                  >
                    <Menu />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-[260px] gap-0 p-0">
                  <SheetTitle className="sr-only">会议助手导航</SheetTitle>
                  <SheetDescription className="sr-only">会议管理与部门管理</SheetDescription>
                  <WorkspaceSidebar {...sidebarProps} onNavigate={() => setMobileOpen(false)} />
                </SheetContent>
              </Sheet>
              <PanelsTopLeft className="desktop-breadcrumb-icon size-4 text-neutral-400" />
              <nav aria-label="面包屑" className="breadcrumb">
                <span>工作空间</span>
                <ChevronRight />
                <a href={page === "departments" ? "#departments" : "#"}>{page === "departments" ? "部门管理" : "会议管理"}</a>
                {state.meeting && (
                  <>
                    <ChevronRight />
                    <span className="breadcrumb-current">会议详情</span>
                  </>
                )}
              </nav>
            </div>
            <span className="topbar-date">
              <CalendarDays />
              {new Date().toLocaleDateString("zh-CN", {
                month: "long",
                day: "numeric",
                weekday: "long",
              })}
            </span>
          </header>
          {visibleError && (
            <div className="page-error">
              <Alert
                variant="destructive"
                id="error-message"
                className="items-center border-neutral-200 bg-neutral-50"
              >
                <AlertCircle />
                <AlertDescription className="pr-7">{visibleError}</AlertDescription>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="关闭错误提示"
                  onClick={() => {
                    setError("")
                    session.dismissError()
                  }}
                  className="absolute right-2 top-2"
                >
                  <X />
                </Button>
              </Alert>
            </div>
          )}
          {routing ? (
            <div className="page-content loading-page">
              <Skeleton className="mb-4 h-8 w-44" />
              <Skeleton className="mb-9 h-4 w-72 max-w-full" />
              <Skeleton className="h-80 w-full rounded-xl" />
            </div>
          ) : page === "departments" ? (
              <DepartmentManagement departments={departments} onChanged={refresh} />
          ) : state.meeting ? (
            <MeetingDetail
              key={state.meeting.id}
              session={session}
              onError={setError}
              modelsVersion={modelsVersion}
              onConfigure={configureModels}
            />
          ) : (
            <MeetingList
              meetings={meetings}
              loading={loading}
              departments={departments}
              filters={filters}
              onFilters={setFilters}
              onCreate={() => setCreateOpen(true)}
              onRefresh={() => {
                setError("")
                void refresh()
              }}
            />
          )}
        </main>
      </div>
      <CreateMeetingDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={created} />
      <ModelConfigDialog
        open={modelsOpen}
        onOpenChange={setModelsOpen}
        onSaved={() => setModelsVersion((value) => value + 1)}
      />
    </TooltipProvider>
  )
}
