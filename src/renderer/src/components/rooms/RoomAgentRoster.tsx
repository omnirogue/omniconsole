import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { RoomAgent } from '../../../../shared/rooms'

export function RoomAgentRoster({ agents }: { agents: RoomAgent[] }): React.JSX.Element {
  return (
    <details className="border-b border-border px-3 py-2 text-sm">
      <summary className="cursor-pointer text-muted-foreground">
        {translate('rooms.agents', 'Room agents')} ({agents.length})
      </summary>
      <ul className="space-y-2 pt-2">
        {agents.map((agent) => (
          <li key={agent.id} className="flex flex-wrap items-center gap-2">
            <span>{agent.name}</span>
            <Badge variant="outline">
              {agent.available
                ? translate('rooms.available', 'Available')
                : translate('rooms.unavailable', 'Unavailable')}
            </Badge>
            {agent.mode === 'manual' ? (
              <Badge variant="outline">{translate('rooms.manual', 'Manual')}</Badge>
            ) : null}
            <Badge variant="secondary">{gateLabel(agent.respondTo)}</Badge>
            <Badge variant="secondary">
              {agent.delivery === 'owner-interrupt'
                ? translate('rooms.interrupt', 'Owner can interrupt')
                : agent.delivery === 'queue'
                  ? translate('rooms.queue', 'Queue')
                  : translate('rooms.unknownDelivery', 'Delivery unavailable')}
            </Badge>
            <Badge variant="secondary">{exposureLabel(agent.exposure)}</Badge>
            {agent.repliesUsed !== undefined && agent.maxReplies !== undefined ? (
              <span className="text-xs text-muted-foreground">
                {translate('rooms.replies', '{{used}}/{{limit}} replies', {
                  used: agent.repliesUsed,
                  limit: agent.maxReplies
                })}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  )
}
function gateLabel(gate: RoomAgent['respondTo']) {
  if (gate === 'owner-only') {
    return translate('rooms.ownerOnly', 'Owner only')
  }
  if (gate === 'room-members') {
    return translate('rooms.roomMembers', 'Room members')
  }
  if (gate === 'selected') {
    return translate('rooms.selectedPeople', 'Selected people')
  }
  if (gate === 'paused') {
    return translate('rooms.paused', 'Paused')
  }
  return translate('rooms.unknownGate', 'Gate unavailable')
}
function exposureLabel(exposure: RoomAgent['exposure']) {
  if (exposure === 'participant') {
    return translate('rooms.participant', 'Participant')
  }
  if (exposure === 'transcript') {
    return translate('rooms.transcript', 'Transcript')
  }
  if (exposure === 'live') {
    return translate('rooms.live', 'Live activity')
  }
  return translate('rooms.unknownExposure', 'Exposure unavailable')
}
