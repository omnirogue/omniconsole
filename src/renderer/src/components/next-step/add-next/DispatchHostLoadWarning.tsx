import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { toSshExecutionHostId } from '../../../../../shared/execution-host'
import type { ConsoleConversationFleetInventory } from '../../../../../shared/console-conversation-fleet-types'
import {
  deriveHostResourceView,
  formatLoadPerCore,
  hostLoadWarning,
  type HostLoadCandidate
} from '../../../../../shared/host-resource-model'
import { fleetMachineHealth } from '../../fleet/fleet-machine-health'
import {
  useHostResourceClock,
  useHostResourceReadings
} from '../../host-resources/host-resource-poller'
import type { NextStepLoad } from '../use-next-step-recipients'
import type { FleetTarget } from './dispatch-to-fleet'

const NO_LABELS = new Map<string, string>()

/**
 * Warns when the chosen fleet machine is `hot` (load per core above 0.8) and names the freest `ok`
 * machine. Advice only: the choice and the dispatch are untouched. The runner's own report wins;
 * a machine without one falls back to the paired SSH host of the same name.
 */
export function DispatchHostLoadWarning({
  inventory,
  target
}: {
  inventory: NextStepLoad<ConsoleConversationFleetInventory> | null
  target: FleetTarget | null
}) {
  const sshLabels = useAppStore((state) => state.sshTargetLabels) ?? NO_LABELS
  const machines =
    inventory?.phase === 'ready' ? inventory.value.machines.map(fleetMachineHealth) : []
  const hostKeyByName = new Map<string, string>()
  for (const [targetId, label] of sshLabels) {
    hostKeyByName.set(label.toLowerCase(), toSshExecutionHostId(targetId))
  }
  const fallbackKeys = machines
    .filter((machine) => machine.ratio === null)
    .flatMap((machine) => hostKeyByName.get(machine.host.toLowerCase()) ?? [])
  const readings = useHostResourceReadings(target?.machineId ? fallbackKeys : [])
  const now = useHostResourceClock()
  const candidates: HostLoadCandidate[] = machines.map((machine) => {
    const key = hostKeyByName.get(machine.host.toLowerCase())
    const paired = key ? deriveHostResourceView(readings.get(key), now) : null
    return {
      id: machine.host,
      label: machine.host,
      loadPerCore: machine.ratio ?? paired?.loadPerCore ?? null,
      available: machine.available
    }
  })
  const warning = hostLoadWarning(candidates, target?.machineId ?? null)
  if (!warning) {
    return null
  }
  return (
    <p
      className="px-2 text-[10px] leading-4 text-yellow-600 dark:text-yellow-500"
      role="status"
      data-dispatch-load-warning={warning.target.id}
    >
      {translate(
        'hostResources.dispatchHot',
        '{{host}} is hot: load {{load}} per core. It will still run there.',
        { host: warning.target.label, load: formatLoadPerCore(warning.target.loadPerCore, 2) }
      )}{' '}
      {warning.suggestion && warning.suggestion.loadPerCore !== null
        ? translate(
            'hostResources.dispatchSuggest',
            '{{host}} is the freest ({{load}} per core); consider choosing it instead.',
            {
              host: warning.suggestion.label,
              load: formatLoadPerCore(warning.suggestion.loadPerCore, 2)
            }
          )
        : translate(
            'hostResources.dispatchNoSuggestion',
            'No other machine is under 0.6 per core right now.'
          )}
    </p>
  )
}
