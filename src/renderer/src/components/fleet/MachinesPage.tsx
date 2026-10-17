import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  fleetMachineHealth,
  formatFleetLastBeat,
  formatFleetMemory,
  type FleetMachineHealth
} from './fleet-machine-health'
import { useFleetInventory } from './use-fleet-inventory'

function LoadCell({ health }: { health: FleetMachineHealth }) {
  if (health.load1 === null || health.cores === null) {
    return <span className="text-muted-foreground">{translate('machines.noReading', '—')}</span>
  }
  const percent = Math.min(100, Math.round((health.ratio ?? 0) * 100))
  return (
    <span className="flex items-center gap-2">
      <span
        className="inline-block h-1.5 w-16 overflow-hidden rounded-full border bg-muted"
        aria-hidden="true"
      >
        <span
          className={`block h-full ${percent < 50 ? 'bg-emerald-600' : percent < 80 ? 'bg-amber-500' : 'bg-destructive'}`}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="tabular-nums">
        {translate('machines.loadOfCores', '{{load}} / {{cores}}', {
          load: health.load1.toFixed(1),
          cores: health.cores
        })}
      </span>
    </span>
  )
}

/**
 * Agents → Machines: the same fleet inventory the 🚀 popover reads, laid out so a person
 * can see at a glance which machine is busy, which is signed in, and which went quiet.
 */
export default function MachinesPage(): React.JSX.Element {
  useTranslation()
  const { inventory, reload } = useFleetInventory()
  const machines =
    inventory.phase === 'ready' ? inventory.value.machines.map(fleetMachineHealth) : []
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek px-5 py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-sm font-semibold">{translate('machines.title', 'Machines')}</h1>
            <p className="text-xs text-muted-foreground">
              {translate(
                'machines.help',
                'The fleet machines that can take dispatched work, as the hub last heard from them.'
              )}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={reload}>
            <RefreshCw className="size-3.5" />
            {translate('machines.refresh', 'Refresh')}
          </Button>
        </div>
        {inventory.phase === 'loading' ? (
          <p className="text-xs text-muted-foreground" role="status">
            {translate('machines.loading', 'Reading the fleet inventory…')}
          </p>
        ) : null}
        {inventory.phase === 'error' ? (
          <p className="text-xs text-destructive" role="alert">
            {translate('machines.error', 'The fleet inventory could not be read: {{message}}', {
              message: inventory.message
            })}
          </p>
        ) : null}
        {inventory.phase === 'ready' && machines.length === 0 ? (
          <p className="text-xs text-muted-foreground" role="status">
            {translate(
              'machines.empty',
              'No fleet machine is registered for this company yet. Nothing can be dispatched until one reports in.'
            )}
          </p>
        ) : null}
        {machines.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-machines-table>
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{translate('machines.host', 'Host')}</th>
                  <th className="py-2 pr-3 font-medium">{translate('machines.load', 'Load')}</th>
                  <th className="py-2 pr-3 font-medium">
                    {translate('machines.memory', 'Memory')}
                  </th>
                  <th className="py-2 pr-3 font-medium">{translate('machines.slots', 'Slots')}</th>
                  <th className="py-2 pr-3 font-medium">
                    {translate('machines.running', 'Running')}
                  </th>
                  <th className="py-2 pr-3 font-medium">
                    {translate('machines.agents', 'Agents')}
                  </th>
                  <th className="py-2 font-medium">
                    {translate('machines.lastBeat', 'Last beat')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {machines.map((health) => (
                  <tr
                    key={health.host}
                    className={`border-t ${health.available ? '' : 'opacity-55'}`}
                    data-machine-row={health.host}
                  >
                    <td className="py-2 pr-3 font-mono font-semibold">
                      {health.host}
                      {health.reason ? (
                        <span className="block font-sans text-[10px] font-normal text-muted-foreground">
                          {health.reason}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">
                      <LoadCell health={health} />
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {formatFleetMemory(health.memUsedBytes, health.memTotalBytes) ??
                        translate('machines.noReading', '—')}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {translate('machines.slotsFree', '{{free}} of {{slots}} free', {
                        free: health.freeSlots,
                        slots: health.slots
                      })}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{health.running}</td>
                    <td className="py-2 pr-3">
                      {health.agents.length === 0
                        ? translate('machines.noAgents', 'No agent reported')
                        : health.agents.map((agent) => (
                            <span key={agent.provider} className="block">
                              {translate('machines.agentLine', '{{provider}} · {{detail}}', {
                                provider: agent.provider,
                                detail: agent.detail
                              })}
                            </span>
                          ))}
                    </td>
                    <td className="py-2">
                      {formatFleetLastBeat(health.lastBeat) ??
                        translate('machines.neverReported', 'never')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </main>
  )
}
