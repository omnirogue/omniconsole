import { translate } from '@/i18n/i18n'
import { getAgentCatalog } from '@/lib/agent-catalog'
import type { LedgerPublicRow } from '@/lib/session-ledger-types'

export function lastActionLabel(action: LedgerPublicRow['last_action']): string {
  if (action?.kind !== 'stop') {
    return action?.target ?? ''
  }
  switch (action.target) {
    case 'turn_end':
      return translate('sessionLedger.turnEnded', 'Turn ended')
    case 'exit':
      return translate('sessionLedger.exited', 'Exited')
    case 'close':
      return translate('sessionLedger.closed', 'Closed')
    case 'quit':
      return translate('sessionLedger.quit', 'Quit')
    case 'abandoned':
      return translate('sessionLedger.abandoned', 'Abandoned')
    default:
      return action.target
  }
}

function agentLabel(value: string | null | undefined): string {
  if (!value) {
    return ''
  }
  switch (value) {
    case 'hub':
      return translate('sessionLedger.hub', 'Hub')
    case 'other':
      return translate('sessionLedger.otherAgent', 'other agent')
    default:
      return getAgentCatalog().find((entry) => entry.id === value)?.label ?? value
  }
}

export function sessionAgentLabel(
  agent: string | null | undefined,
  model: string | null | undefined
): string {
  return [agentLabel(agent), agentLabel(model)].filter(Boolean).join(' · ')
}
