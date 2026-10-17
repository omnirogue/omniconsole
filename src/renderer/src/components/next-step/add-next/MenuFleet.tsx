import { translate } from '@/i18n/i18n'
import {
  fleetMachineHealth,
  formatFleetLoad,
  formatFleetMemory,
  type FleetMachineHealth
} from '../../fleet/fleet-machine-health'
import type { ConsoleConversationFleetInventory } from '../../../../../shared/console-conversation-fleet-types'
import type { NextStepLoad } from '../use-next-step-recipients'
import type { FleetTarget } from './dispatch-to-fleet'
import { MenuItem, MenuItems } from './MenuItems'

/** The load bar, drawn only when the runner reported both load and cores. */
function LoadBar({ ratio }: { ratio: number }) {
  const percent = Math.min(100, Math.round(ratio * 100))
  return (
    <span
      className="inline-block h-1.5 w-12 overflow-hidden rounded-full border bg-muted align-middle"
      aria-hidden="true"
    >
      <span
        className={`block h-full ${percent < 50 ? 'bg-emerald-600' : percent < 80 ? 'bg-amber-500' : 'bg-destructive'}`}
        style={{ width: `${percent}%` }}
      />
    </span>
  )
}

function MachineMeta({ health }: { health: FleetMachineHealth }) {
  const load = formatFleetLoad(health)
  const memory = formatFleetMemory(health.memUsedBytes, health.memTotalBytes)
  const agents = health.agents
    .map((agent) =>
      translate('conversationFleet.agentLine', '{{provider}} · {{detail}}', {
        provider: agent.provider,
        detail: agent.detail
      })
    )
    .join(' · ')
  return (
    <span className="block text-[10px] leading-4 text-muted-foreground">
      {load ? (
        <span className="mr-2 whitespace-nowrap">
          {health.ratio !== null ? <LoadBar ratio={health.ratio} /> : null} {load}
        </span>
      ) : null}
      {memory ? <span className="mr-2 whitespace-nowrap">{memory}</span> : null}
      <span className="mr-2 whitespace-nowrap">
        {translate('conversationFleet.slotsFree', '{{free}} of {{slots}} slots free', {
          free: health.freeSlots,
          slots: health.slots
        })}
      </span>
      <span className="mr-2 whitespace-nowrap">
        {translate('conversationFleet.runningJobs', '{{count}} running', {
          count: health.running
        })}
      </span>
      {agents ? <span className="block">{agents}</span> : null}
      {health.reason ? <span className="block">{health.reason}</span> : null}
    </span>
  )
}

/**
 * Fleet first: the hub's own machines, with the health a person needs to choose one. The
 * automatic item leaves the choice to the hub, which is what most dispatches want.
 */
export function MenuFleet({
  inventory,
  selected,
  onPreview,
  onChoose
}: {
  inventory: NextStepLoad<ConsoleConversationFleetInventory>
  selected: FleetTarget | null
  /** Hover; absent, hovering chooses like a click. */
  onPreview?: (target: FleetTarget) => void
  onChoose: (target: FleetTarget) => void
}) {
  const preview = onPreview ?? onChoose
  const machines =
    inventory.phase === 'ready' ? inventory.value.machines.map(fleetMachineHealth) : []
  return (
    <MenuItems label={translate('nextStep.fleetSection', 'Fleet')}>
      <p className="flex items-baseline justify-between gap-2 px-2 text-xs font-medium">
        {translate('nextStep.fleetSection', 'Fleet')}
        <span className="text-[10px] font-normal text-muted-foreground">
          {translate('nextStep.fleetPicksMachine', 'the hub picks the machine')}
        </span>
      </p>
      <MenuItem
        selected={selected !== null && selected.machineId === null}
        onPreview={() => preview({ machineId: null })}
        onChoose={() => onChoose({ machineId: null })}
      >
        <span>
          {translate('nextStep.dispatchToFleet', '🚀 Dispatch to fleet · automatic')}
          <span className="block text-[10px] leading-4 text-muted-foreground">
            {translate('nextStep.fleetAutomaticHelp', 'Runs on the best available machine below.')}
          </span>
        </span>
      </MenuItem>
      {machines.map((health) => (
        <MenuItem
          key={health.host}
          selected={selected?.machineId === health.host}
          onPreview={health.available ? () => preview({ machineId: health.host }) : undefined}
          onChoose={() => {
            // Why: a machine the console will not admit is shown with its reason, never run on.
            if (health.available) {
              onChoose({ machineId: health.host })
            }
          }}
        >
          <span className={health.available ? '' : 'opacity-55'} data-fleet-machine={health.host}>
            {health.host}
            <MachineMeta health={health} />
          </span>
        </MenuItem>
      ))}
      {inventory.phase === 'loading' ? (
        <p className="px-2 text-[10px] leading-4 text-muted-foreground" role="status">
          {translate('nextStep.loadingFleet', 'Checking fleet availability…')}
        </p>
      ) : null}
      {inventory.phase === 'error' ? (
        <p className="px-2 text-[10px] leading-4 text-destructive" role="status">
          {inventory.message}
        </p>
      ) : null}
      {inventory.phase === 'ready' && machines.length === 0 ? (
        <p className="px-2 text-[10px] leading-4 text-muted-foreground" role="status">
          {translate(
            'nextStep.noFleetMachines',
            'No fleet machine is registered yet. Dispatch still works; the hub queues the job.'
          )}
        </p>
      ) : null}
    </MenuItems>
  )
}
