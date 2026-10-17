import { useCallback, useEffect, useMemo, useState } from 'react'
import { Info } from 'lucide-react'
import { Button } from '../ui/button'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import {
  isAnyPtyBusy,
  resolveDaemonVersionDrift,
  type DaemonVersionReport
} from '../../../../shared/daemon-version-drift'

export function useDaemonVersionReport(refreshRevision = 0): DaemonVersionReport | null {
  const [report, setReport] = useState<DaemonVersionReport | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setReport(await window.api.pty.management.daemonVersion())
    } catch {
      setReport(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Why: a daemon restart changes the answer without a pane remount.
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh, refreshRevision])

  return report
}

/**
 * Why this exists: a healthy daemon that still owns live sessions is preserved across an
 * in-place app upgrade (daemon-replacement-preflight.ts defers the `stale_bundle` replacement),
 * so terminals keep running the previous install's daemon code until someone restarts it. This
 * is informational only — the restart is the user's call, once no terminal would lose work.
 */
export function DaemonVersionDriftNotice(props: {
  onRestartDaemon: () => void
  /** Increment after a daemon replacement attempt so the drift is re-checked. */
  refreshRevision?: number
  /** True while a daemon action is already running. */
  isBusy?: boolean
}): React.JSX.Element | null {
  const report = useDaemonVersionReport(props.refreshRevision)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const anyPtyBusy = useMemo(() => isAnyPtyBusy(agentStatusByPaneKey), [agentStatusByPaneKey])
  const drift = resolveDaemonVersionDrift(report)

  if (!drift.drifted) {
    return null
  }

  const restartDisabled = anyPtyBusy || props.isBusy === true
  const waitHint = translate(
    'auto.components.settings.DaemonVersionDriftNotice.waitUntilIdle',
    'Wait until every terminal is idle'
  )

  return (
    <div
      role="status"
      data-daemon-version-drift-notice=""
      className="flex items-start justify-between gap-4 rounded-lg border border-sky-500/40 bg-sky-500/10 px-4 py-3 text-sky-800 dark:text-sky-200"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p className="text-sm leading-snug">
          {translate(
            'auto.components.settings.DaemonVersionDriftNotice.body',
            'Terminal daemon is from {{version}}; restart it when your sessions are idle to apply updates',
            { version: drift.daemonVersion }
          )}
        </p>
      </div>
      <span className="shrink-0" title={restartDisabled && anyPtyBusy ? waitHint : undefined}>
        <Button
          variant="outline"
          size="sm"
          disabled={restartDisabled}
          aria-disabled={restartDisabled}
          onClick={props.onRestartDaemon}
        >
          {translate('auto.components.settings.DaemonVersionDriftNotice.restart', 'Restart daemon')}
        </Button>
      </span>
    </div>
  )
}
