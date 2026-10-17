import { useAppStore } from '@/store'
import { resolvePaneLaunchTrigger } from '@/lib/launch-trigger/pane-launch-trigger'
import { wasTerminalTabRevealedByPerson } from '@/lib/launch-trigger/person-reveal-evidence'
import type { DescribePaneLaunch } from '../ipc-pty-spawn-launch-attribution'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Describes every pane spawn independently of tracing; never controls admission. */
export function createPaneLaunchDescriber(session: ConnectPanePtySession): DescribePaneLaunch {
  return (spawn) => {
    const state = useAppStore.getState()
    const visible = Boolean(session.deps.isVisibleRef.current)
    return {
      trigger:
        session.paneStartup?.launchTrigger ??
        resolvePaneLaunchTrigger({
          ...spawn,
          hibernationWakeInFlight: session.hibernatedWakeInFlightClaimKey != null,
          sleepingRecord: session.getSleepingRecordForPane?.(state)?.record ?? null,
          visible,
          revealedByPerson: wasTerminalTabRevealedByPerson(session.deps.tabId)
        }),
      visible
    }
  }
}
