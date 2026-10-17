import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { ConsoleConversationFleetInventory } from '../../../../../shared/console-conversation-fleet-types'
import type { NextStepLoad } from '../use-next-step-recipients'
import type { FleetTarget } from './dispatch-to-fleet'
import { DispatchHostLoadWarning } from './DispatchHostLoadWarning'
import { MenuComputers } from './MenuComputers'
import { MenuFleet } from './MenuFleet'

/**
 * Where 🚀 sends this work: the fleet first, because that is what the machines are for,
 * and this person's own computers underneath — nobody else can see or use those.
 */
export function MenuTargets({
  inventory,
  fleetTarget,
  placement,
  sourceWorktreeId,
  onFleet,
  onFleetPreview,
  onHost,
  onHostPreview
}: {
  /** Absent when this subject has no fleet path at all; then only the computers show. */
  inventory: NextStepLoad<ConsoleConversationFleetInventory> | null
  fleetTarget: FleetTarget | null
  placement: ExecutionHostId | null
  sourceWorktreeId: string | null
  onFleet: (target: FleetTarget) => void
  onFleetPreview: (target: FleetTarget) => void
  onHost: (placement: ExecutionHostId) => void
  onHostPreview: (placement: ExecutionHostId) => void
}) {
  return (
    <>
      {inventory ? (
        <>
          <MenuFleet
            inventory={inventory}
            selected={fleetTarget}
            onPreview={onFleetPreview}
            onChoose={onFleet}
          />
          <DispatchHostLoadWarning inventory={inventory} target={fleetTarget} />
        </>
      ) : null}
      <div className={inventory ? 'border-t pt-2' : ''}>
        <p className="px-2 pb-1 text-[10px] leading-4 text-muted-foreground">
          {translate('nextStep.myComputersOnlyYou', 'My computers · only you see these')}
        </p>
        <MenuComputers
          selected={placement}
          sourceWorktreeId={sourceWorktreeId}
          onPreview={onHostPreview}
          onChoose={onHost}
        />
      </div>
    </>
  )
}
