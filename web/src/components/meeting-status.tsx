import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { statusLabels, type MeetingStatus } from "@/lib/meetings"

export function MeetingStatusBadge({ status, id }: { status: MeetingStatus; id?: string }) {
  return (
    <Badge
      id={id}
      variant="secondary"
      className={cn(
        "meeting-status gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
        `status-${status}`,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {statusLabels[status]}
    </Badge>
  )
}
