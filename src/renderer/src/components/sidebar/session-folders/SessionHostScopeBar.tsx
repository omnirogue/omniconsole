import { ChevronDown, Globe, House, Plug, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { RuntimeComputerMenu } from './RuntimeComputerMenu'
import {
  hideSessionHostKind,
  inSessionHostFilter,
  onlySessionHostKind,
  sessionHostKindMarks,
  showAllSessionHostsOfKind,
  toggleSessionHost,
  toggleSessionHostKind,
  type SessionHostFilter
} from '@/lib/session-host-scope'
import {
  everywhereSessionHostFilter,
  homeSessionHostFilter,
  showsSessionHostKind
} from '@/lib/session-host-switch'
import type { ExecutionHostId, ExecutionHostKind } from '../../../../../shared/execution-host'
import type { ExecutionHostHealth } from '../../../../../shared/execution-host-registry'
import {
  getSidebarHostHealthLabel,
  shouldShowHostScopeControls,
  type SidebarHostOption
} from '../sidebar-host-options'

function healthDotClass(health: ExecutionHostHealth): string {
  switch (health) {
    case 'available':
      return 'bg-status-success'
    case 'connecting':
      return 'bg-status-warning'
    case 'blocked':
    case 'error':
      return 'bg-destructive'
    case 'disconnected':
    case 'local':
      return 'bg-muted-foreground/50'
  }
}

type KindCopy = { icon: LucideIcon; label: string; hint: string; empty: string; choose: string }

function kindCopy(kind: ExecutionHostKind): KindCopy {
  switch (kind) {
    case 'local':
      return {
        icon: House,
        label: translate('sessionHosts.home', 'Home'),
        hint: translate('sessionHosts.homeHint', 'Home: sessions on this computer only'),
        empty: '',
        choose: ''
      }
    case 'runtime':
      return {
        icon: Globe,
        label: translate('sessionHosts.runtimes', 'Paired runtimes'),
        hint: translate(
          'sessionHosts.runtimesHint',
          'Globe: sessions on this computer and every paired runtime'
        ),
        empty: translate('sessionHosts.runtimesEmpty', 'No paired runtimes yet'),
        choose: translate('sessionHosts.chooseRuntimes', 'Choose paired runtimes')
      }
    case 'ssh':
      return {
        icon: Plug,
        label: translate('sessionHosts.ssh', 'SSH hosts'),
        hint: translate('sessionHosts.sshHint', 'Sessions on SSH hosts'),
        empty: translate(
          'sessionHosts.sshNeedsWorkspace',
          'Add a workspace on an SSH host to see its sessions here'
        ),
        choose: translate('sessionHosts.chooseSsh', 'Choose SSH hosts')
      }
  }
}

function sessionCountLabel(count: number): string {
  return count === 1
    ? translate('sessionHosts.oneSession', '1 session')
    : translate('sessionHosts.sessions', '{{count}} sessions', { count })
}

type BarProps = {
  activeHostId?: ExecutionHostId
  selectHost?: (hostId: ExecutionHostId) => Promise<boolean>
  filter: SessionHostFilter
  hostOptions: readonly SidebarHostOption[]
  /** Saved SSH connections left off the list: no workspace points at them, no session names them. */
  sshWithoutWorkspace: number
  sessionCounts: ReadonlyMap<ExecutionHostId, number>
  /** Sessions asking for a person, per host, whatever the filter. */
  askCounts: ReadonlyMap<ExecutionHostId, number>
  /** Listed with Home but counted as no computer's: their host is unknown (step 9). */
  unknownHostCount?: number
  setHostFilter: (filter: SessionHostFilter) => void
}

function HostKindMenu({
  kind,
  hosts,
  copy,
  filter,
  hostOptions,
  sshWithoutWorkspace,
  sessionCounts,
  setHostFilter
}: BarProps & { kind: ExecutionHostKind; hosts: readonly SidebarHostOption[]; copy: KindCopy }) {
  const allShown = hosts.every((host) => inSessionHostFilter(host.id, filter))
  const noneShown = !hosts.some((host) => inSessionHostFilter(host.id, filter))
  const withSessionsFirst = [...hosts].sort(
    (a, b) =>
      Number((sessionCounts.get(b.id) ?? 0) > 0) - Number((sessionCounts.get(a.id) ?? 0) > 0)
  )
  const folded = kind === 'ssh' ? sshWithoutWorkspace : 0
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="-ml-0.5 w-3.5 shrink-0 text-muted-foreground"
          aria-label={copy.choose}
        >
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuLabel>{copy.label}</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={allShown && filter.kinds.includes(kind)}
          onSelect={() => setHostFilter(showAllSessionHostsOfKind(filter, kind))}
        >
          {translate('sessionHosts.allOfKind', 'All')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={noneShown}
          onSelect={() => setHostFilter(hideSessionHostKind(filter, kind, hostOptions))}
        >
          {translate('sessionHosts.noneOfKind', 'None')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {withSessionsFirst.map((host) => (
          <DropdownMenuCheckboxItem
            key={host.id}
            checked={inSessionHostFilter(host.id, filter)}
            // Why: keep the menu open so several hosts can be picked in one go.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => setHostFilter(toggleSessionHost(filter, host.id, hostOptions))}
            aria-label={`${host.label} (${getSidebarHostHealthLabel(host.health)})`}
          >
            <span
              aria-hidden
              className={cn('size-1.5 shrink-0 rounded-full', healthDotClass(host.health))}
            />
            <span className="min-w-0 truncate">{host.label}</span>
            <DropdownMenuShortcut>{sessionCounts.get(host.id) ?? 0}</DropdownMenuShortcut>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => setHostFilter(onlySessionHostKind(filter, kind, hostOptions))}
        >
          {translate('sessionHosts.onlyKind', 'Only {{label}}', { label: copy.label })}
        </DropdownMenuItem>
        {folded ? (
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            {folded === 1
              ? translate(
                  'sessionHosts.oneWithoutWorkspace',
                  '1 saved connection without a workspace'
                )
              : translate(
                  'sessionHosts.withoutWorkspace',
                  '{{count}} saved connections without a workspace',
                  { count: folded }
                )}
          </DropdownMenuLabel>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function HostKindControl(props: BarProps & { kind: ExecutionHostKind }) {
  const { kind, filter, hostOptions, sessionCounts, askCounts, setHostFilter } = props
  const copy = kindCopy(kind)
  const hosts = hostOptions.filter((host) => host.kind === kind)
  const shown = hosts.filter((host) => inSessionHostFilter(host.id, filter))
  const sessions = shown.reduce((sum, host) => sum + (sessionCounts.get(host.id) ?? 0), 0)
  const partial = shown.length > 0 && shown.length < hosts.length
  const detail = partial
    ? translate('sessionHosts.someShown', '{{shown}} of {{total}} shown', {
        shown: shown.length,
        total: hosts.length
      })
    : null
  // Why: Home is one computer; only the kinds that gather several hosts carry the marks.
  const marks =
    kind === 'local'
      ? { hostsWithSessions: 0, asksElsewhere: false }
      : sessionHostKindMarks(kind, filter, sessionCounts, askCounts)
  const asksHint = marks.asksElsewhere
    ? translate('sessionHosts.asksElsewhere', 'A session on a host not shown needs you')
    : null
  const Icon = copy.icon
  // Why: Home and the Globe are one switch — Home is this computer alone, the Globe is this
  // computer and every paired runtime at once — so each is a single click from the other and a
  // click never lands on nothing. The plug stays a toggle that adds SSH hosts to either.
  const globe = showsSessionHostKind(filter, 'runtime', hostOptions)
  const pressed = kind === 'local' ? shown.length > 0 && !globe : shown.length > 0
  const choose = (): void => {
    if (kind === 'local') {
      // Why: the view changes at once; bringing launches home may take a round trip or fail.
      setHostFilter(homeSessionHostFilter(filter))
      void props.selectHost?.('local')
    } else if (kind === 'runtime') {
      setHostFilter(everywhereSessionHostFilter(filter))
    } else {
      setHostFilter(toggleSessionHostKind(filter, kind, hostOptions))
    }
  }
  const launchesOn =
    kind === 'runtime' && props.activeHostId && props.activeHostId !== 'local'
      ? (hostOptions.find((host) => host.id === props.activeHostId)?.label ?? props.activeHostId)
      : null
  const unknownHint =
    kind === 'local' && shown.length && props.unknownHostCount
      ? translate('sessionHosts.unknownComputer', 'Unknown computer: {{count}}', {
          count: props.unknownHostCount
        })
      : null
  const launchHint = launchesOn
    ? translate('sessionHosts.launchesOn', 'New sessions start on {{name}}', { name: launchesOn })
    : null
  const hint = hosts.length
    ? [
        copy.hint,
        detail,
        shown.length ? sessionCountLabel(sessions) : null,
        unknownHint,
        asksHint,
        launchHint
      ]
        .filter(Boolean)
        .join(' · ')
    : copy.empty
  const label = [copy.label, detail, asksHint].filter(Boolean).join(', ')
  const control = (
    <Button
      type="button"
      variant={pressed ? 'secondary' : 'ghost'}
      size="icon-xs"
      className="relative shrink-0 text-muted-foreground"
      aria-label={label}
      aria-pressed={pressed}
      disabled={hosts.length === 0}
      onClick={choose}
    >
      <Icon className="size-3.5" />
      {partial ? (
        <span
          aria-hidden
          className="absolute left-0.5 top-0.5 size-1 rounded-full bg-muted-foreground"
        />
      ) : null}
      {marks.hostsWithSessions ? (
        <span
          aria-hidden
          data-testid={`${kind}-hosts-with-sessions`}
          className="absolute -right-0.5 -top-0.5 min-w-3 rounded-full bg-foreground px-0.5 text-[9px] font-semibold leading-3 text-background tabular-nums"
        >
          {marks.hostsWithSessions > 9 ? '9+' : marks.hostsWithSessions}
        </span>
      ) : null}
      {marks.asksElsewhere ? (
        <span
          aria-hidden
          className="absolute bottom-0.5 right-0.5 size-1.5 rounded-full bg-status-warning"
        />
      ) : null}
    </Button>
  )
  return (
    <div className="flex shrink-0 items-center">
      <Tooltip>
        <TooltipTrigger asChild>
          {hosts.length ? control : <span className="inline-flex">{control}</span>}
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
      {kind === 'runtime' && hosts.length && props.selectHost ? (
        <RuntimeComputerMenu
          hosts={hostOptions}
          activeHostId={props.activeHostId ?? 'local'}
          onSelectHost={props.selectHost}
        />
      ) : kind !== 'local' && hosts.length ? (
        <HostKindMenu {...props} hosts={hosts} copy={copy} />
      ) : null}
    </div>
  )
}

/**
 * Whose sessions the list shows: Home (this computer only, the default) or the Globe (this computer
 * and every paired runtime), one click apart, with the plug adding SSH hosts to either. The chevron
 * beside the Globe picks one computer to view and start sessions on; the plug's narrows SSH hosts.
 * Only there once another host is set up; until then every session is Home.
 */
export function SessionHostScopeBar(props: BarProps) {
  // Why: with only saved connections and no workspace on them, the plug stays to say what's missing.
  if (!shouldShowHostScopeControls(props.hostOptions) && props.sshWithoutWorkspace === 0) {
    return null
  }
  return (
    <div
      role="group"
      aria-label={translate('sessionHosts.label', 'Sessions from')}
      className="flex min-w-0 items-center gap-1"
    >
      <HostKindControl {...props} kind="local" />
      <HostKindControl {...props} kind="runtime" />
      <HostKindControl {...props} kind="ssh" />
    </div>
  )
}
