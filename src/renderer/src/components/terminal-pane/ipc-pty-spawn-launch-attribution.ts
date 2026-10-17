// Every spawn carries a description for main; these fields never control admission.
import { normalizeLaunchTrigger, type LaunchTrigger } from '../../../../shared/launch-trigger'

// Why no interruptedRestore: that flag rides on nearly every cold-restore resume; main
// labels the auto-continue itself from the continuation it arms.
export type PaneLaunchSpawnFacts = {
  resumesAgentSession: boolean
  hasStartupCommand: boolean
}

/** A missing description remains unknown in the main ledger. */
export type DescribePaneLaunch = (
  spawn: PaneLaunchSpawnFacts
) => { trigger: LaunchTrigger; visible: boolean } | null

export function launchAttributionSpawnFields(
  describeLaunch: DescribePaneLaunch | undefined,
  spawn: PaneLaunchSpawnFacts
): { launchTrigger?: LaunchTrigger; launchVisible?: boolean } {
  if (!describeLaunch) {
    return {}
  }
  try {
    const described = describeLaunch(spawn)
    if (!described) {
      return {}
    }
    return {
      launchTrigger: normalizeLaunchTrigger(described.trigger),
      // Why typeof: the description crosses a loose boundary; only a real boolean counts.
      launchVisible: typeof described.visible === 'boolean' ? described.visible : false
    }
  } catch {
    return {}
  }
}
