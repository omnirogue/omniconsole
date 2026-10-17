import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { toSshExecutionHostId, type ExecutionHostId } from '../../../../../shared/execution-host'
import { findNextStepWorkspaceId } from '../next-step-placement'
import { MenuItem, MenuItems } from './MenuItems'

export function MenuComputers({
  selected,
  sourceWorktreeId = null,
  onPreview,
  onChoose
}: {
  selected: ExecutionHostId | null
  /** The conversation's workspace; a computer is offered only when it holds a workspace of the same repo. */
  sourceWorktreeId?: string | null
  /** Hover; absent, hovering chooses like a click. */
  onPreview?: (id: ExecutionHostId) => void
  onChoose: (id: ExecutionHostId) => void
}) {
  const ssh = useAppStore((state) => state.sshTargetLabels)
  const connections = useAppStore((state) => state.sshConnectionStates)
  // Why: a plan can only run where a workspace of this repo exists, and Send refuses anything else;
  // a list of every SSH target (most of them other machines entirely) hides the two that matter.
  // The selector returns one string so a store tick never yields a fresh object (React #185).
  const usableKey = useAppStore((state) =>
    sourceWorktreeId
      ? [...(state.sshTargetLabels ?? new Map<string, string>()).keys()]
          .map((id) => toSshExecutionHostId(id))
          .filter((hostId) => findNextStepWorkspaceId(state, sourceWorktreeId, hostId) !== null)
          .join('|')
      : ''
  )
  const usable = new Set(usableKey ? usableKey.split('|') : [])
  const all = [...(ssh ?? new Map<string, string>())]
  const hiddenCount = all.filter(([id]) => !usable.has(toSshExecutionHostId(id))).length
  // Why: a chain cannot follow a session onto a paired runtime host — the launch returns no tab
  // there and the plan fails after the agent already started. Offering it would be a lie.
  const hosts = [
    {
      id: 'local' as const,
      connected: true,
      label: navigator.userAgent.includes('Mac')
        ? translate('nextStep.thisMac', 'This Mac')
        : translate('nextStep.thisComputer', 'This computer')
    },
    ...all
      .filter(([id]) => usable.has(toSshExecutionHostId(id)))
      .map(([id, label]) => ({
        id: toSshExecutionHostId(id),
        label,
        connected: connections?.get(id)?.status === 'connected'
      }))
  ]
  return (
    <MenuItems label={translate('nextStep.runOn', 'Run it on…')}>
      <p className="px-2 text-xs font-medium">{translate('nextStep.runOn', 'Run it on…')}</p>
      {hosts.map((host) => (
        <MenuItem
          key={host.id}
          selected={selected === host.id}
          onPreview={() => (onPreview ?? onChoose)(host.id)}
          onChoose={() => onChoose(host.id)}
        >
          <span>
            {host.label}
            <span className="block text-muted-foreground">
              {host.connected
                ? translate('nextStep.hostConnected', 'Connected')
                : translate('nextStep.hostUnverifiable', 'Unverifiable')}
            </span>
          </span>
        </MenuItem>
      ))}
      {hiddenCount > 0 ? (
        <p className="border-t px-2 pt-2 text-[10px] leading-4 text-muted-foreground">
          {translate(
            'nextStep.hostsWithoutWorkspace',
            '{{count}} more computers have no workspace for this repo · add one under Workspaces (🔧).',
            { count: hiddenCount }
          )}
        </p>
      ) : null}
    </MenuItems>
  )
}
