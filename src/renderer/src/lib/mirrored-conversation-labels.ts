import { translate } from '@/i18n/i18n'
import type { MirroredConversationOwner } from '@/store/slices/mirrored-conversation-ledger'
import type {
  RuntimeSessionConversationRecord,
  SessionConversationRest
} from '../../../shared/session-conversation-ledger'
import type { SidebarSessionLabel } from './sidebar-session-label'

/**
 * A ledger row's name: the owner's sidebar label as sent (addendum F2, the rule #1081's
 * sessionTitle follows). A conversation with no title of its own (`agent`) reads "<agent>
 * (untitled)" in this computer's language. Why from `agent`, never `title`: the owner sends only
 * the agent's name for it, and an older owner sent the English suffix, so the title is not read.
 */
export function mirroredConversationLabel(
  record: Pick<RuntimeSessionConversationRecord, 'agent' | 'title' | 'titleSource'>
): SidebarSessionLabel {
  return record.titleSource !== 'agent' && record.title.trim()
    ? { label: record.title, labelSource: record.titleSource }
    : {
        label: translate('conversations.ledger.untitled', '{{agent}} (untitled)', {
          agent: record.agent
        }),
        labelSource: 'agent'
      }
}

/** Beside a ledger row's name: paused (resumable on its owner) or stopped (not resumable). */
export function mirroredConversationRestLabel(
  rest: SessionConversationRest,
  host: string
): string | null {
  switch (rest) {
    case 'asleep':
      return translate('conversations.ledger.pausedOn', 'paused on {{host}}', { host })
    case 'dormant':
      return translate('conversations.ledger.stoppedOn', 'stopped on {{host}}, not resumable', {
        host
      })
    case 'live':
    case 'unknown':
      return null
  }
}

/** Same day: the clock time; otherwise the date too (numeric shapes follow the OS region). */
function clockTime(at: number, now: number): string {
  const date = new Date(at)
  return date.toDateString() === new Date(now).toDateString()
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
}

/**
 * G2: the owner's ledger state under its computer's heading; null while it is current (`ready`),
 * so a heading only speaks up when its rows are not the owner's live list.
 */
export function mirroredConversationOwnerStateText(
  owner: Pick<MirroredConversationOwner, 'state' | 'asOf' | 'listedAt'> | undefined,
  computer: string,
  now: number = Date.now()
): string | null {
  if (!owner || owner.state === 'ready') {
    return null
  }
  if (owner.state === 'older') {
    return translate(
      'sessionHosts.ledgerOlder',
      'Older OmniConsole on {{computer}}: paused and archived conversations not listed',
      { computer }
    )
  }
  const at = owner.asOf ?? owner.listedAt
  if (at === null) {
    return translate('sessionHosts.ledgerLastList', 'Showing the last list from {{computer}}', {
      computer
    })
  }
  const time = clockTime(at, now)
  return owner.state === 'stale'
    ? translate('sessionHosts.ledgerStale', 'As of {{time}}', { time })
    : translate(
        'sessionHosts.ledgerUnreachable',
        "Can't reach {{computer}} · last listed {{time}}",
        {
          computer,
          time
        }
      )
}
