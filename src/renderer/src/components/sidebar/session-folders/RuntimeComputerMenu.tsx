import { useState } from 'react'
import { toast } from 'sonner'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { HostResourceMeters } from '@/components/host-resources/HostResourceMeters'
import { useHostResourceReadings } from '@/components/host-resources/host-resource-poller'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { getSidebarHostHealthLabel, type SidebarHostOption } from '../sidebar-host-options'

export function RuntimeComputerMenu({
  hosts,
  activeHostId,
  onSelectHost
}: {
  hosts: readonly SidebarHostOption[]
  activeHostId: ExecutionHostId
  onSelectHost: (hostId: ExecutionHostId) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<ExecutionHostId | null>(null)
  const computers = hosts.filter((host) => host.kind !== 'ssh')
  const readings = useHostResourceReadings(
    open
      ? computers
          .filter((host) => host.health === 'local' || host.health === 'available')
          .map((host) => host.id)
      : []
  )
  const selected = computers.find((host) => host.id === activeHostId)
  const select = async (id: ExecutionHostId) => {
    if (pending) {
      return
    }
    setPending(id)
    try {
      if (await onSelectHost(id)) {
        setOpen(false)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(null)
    }
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        {/* Why: the globe beside this is the one-click "everything" view; picking one computer to
            view and start sessions on is the narrower choice, so it lives on the chevron. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="-ml-0.5 w-3.5 shrink-0 text-muted-foreground"
          aria-label={translate('computerPicker.choose', 'Choose computer: {{name}}', {
            name: selected?.label ?? activeHostId
          })}
        >
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>
          {translate('computerPicker.title', 'View and start sessions on')}
        </DropdownMenuLabel>
        {computers.map((host) => (
          <DropdownMenuItem
            key={host.id}
            disabled={pending !== null}
            onSelect={(event) => {
              event.preventDefault()
              void select(host.id)
            }}
            className="flex flex-col items-stretch gap-2 py-3"
            data-current={host.id === activeHostId}
          >
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{host.label}</span>
              <span className="text-xs text-muted-foreground">
                {getSidebarHostHealthLabel(host.health)}
              </span>
              {pending === host.id ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : host.id === activeHostId ? (
                <Check className="size-3.5" />
              ) : null}
            </span>
            <HostResourceMeters
              reading={
                host.health === 'local' || host.health === 'available'
                  ? (readings.get(host.id) ?? null)
                  : null
              }
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
