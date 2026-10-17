import { useMemo } from 'react'
import type React from 'react'
import { translate } from '@/i18n/i18n'
import { useSessionHostsStatus } from '@/lib/session-hosts-client'
import { useSidebarHostScopeOptions } from '../sidebar/use-sidebar-host-scope-options'
import { WorkSectionTitle } from './WorkSectionTitle'
import { otherComputerLines, type OtherComputerLine } from './other-computers-model'

function automationText(state: NonNullable<OtherComputerLine['automationOff']>): string {
  return state === 'applied'
    ? translate('work.otherComputers.automationOff', 'Automatic actions off')
    : translate(
        'work.otherComputers.automationOffPending',
        'Automatic actions off · waiting for it to confirm'
      )
}

/**
 * The other computers that run sessions in the sidebar, one line each: what it can do, and what
 * its own reading of its sessions says. Shown only when there is one.
 */
export function WorkOtherComputersSection(): React.JSX.Element | null {
  const status = useSessionHostsStatus()
  const { hostOptions } = useSidebarHostScopeOptions()
  const labels = useMemo(
    () => new Map(hostOptions.map((host) => [host.id as string, host.label])),
    [hostOptions]
  )
  const lines = useMemo(() => (status ? otherComputerLines(status, labels) : []), [status, labels])
  if (!status || (lines.length === 0 && !status.thisHostOffElsewhere)) {
    return null
  }
  return (
    <section
      aria-label={translate('work.otherComputers.title', 'Other computers')}
      data-work-other-computers={lines.length}
    >
      <WorkSectionTitle
        title={translate('work.otherComputers.title', 'Other computers')}
        sub={translate(
          'work.otherComputers.sub',
          'Each one carries out controls on the sessions it runs'
        )}
      />
      <ul className="space-y-1.5">
        {status.thisHostOffElsewhere ? (
          <li className="rounded-lg border border-dashed px-3 py-2 text-sm">
            {translate(
              'work.otherComputers.thisHostOff',
              'Another Mac switched automatic actions off on this computer.'
            )}
          </li>
        ) : null}
        {lines.map((line) => (
          <li
            key={line.hostKey}
            className="rounded-lg border bg-card px-3 py-2"
            data-other-computer={line.hostKey}
            data-state={line.state}
          >
            <div className="text-sm font-medium">{line.label}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {[line.summary, line.automationOff ? automationText(line.automationOff) : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {line.detail ? (
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{line.detail}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
