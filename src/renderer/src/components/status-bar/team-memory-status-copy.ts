import type { TeamMemoryStatusView } from '../../../../shared/team-memory-contract'
import type { IntegrationStatusTone } from '@/components/integration-status-pill'
import { translate } from '@/i18n/i18n'

export type TeamMemoryStatusCopy = {
  tone: IntegrationStatusTone
  label: string
  detail: string
}

const revision = (value: number | null): string => (value === null ? '–' : `r${value}`)

/** The pill's words for each state. Only "Team memory: loaded / not loaded" ever shows. */
export function teamMemoryStatusCopy(status: TeamMemoryStatusView): TeamMemoryStatusCopy {
  if (status.state === 'unknown') {
    return {
      tone: 'neutral',
      label: translate('auto.components.status.bar.TeamMemory.checking', 'Team memory: checking…'),
      detail: translate(
        'auto.components.status.bar.TeamMemory.checkingDetail',
        'Checking whether the team instructions are loaded.'
      )
    }
  }
  if (status.state === 'loaded') {
    const revisions = translate(
      'auto.components.status.bar.TeamMemory.loaded',
      'Team memory: loaded (everyone {{everyone}} · yours {{personal}})',
      { everyone: revision(status.everyoneRevision), personal: revision(status.personalRevision) }
    )
    if (status.indexOverBudget) {
      return {
        tone: 'attention',
        label: revisions,
        detail: translate(
          'auto.components.status.bar.TeamMemory.overBudget',
          'Team memory index over budget — tell Sal/Uma. Instructions load clipped.'
        )
      }
    }
    return {
      tone: 'connected',
      label: revisions,
      detail: translate(
        'auto.components.status.bar.TeamMemory.loadedDetail',
        'Instructions from Sal and Uma are loaded into your agents. Click to re-check.'
      )
    }
  }
  const reason = {
    not_signed_in: translate('auto.components.status.bar.TeamMemory.notSignedIn', 'not signed in'),
    no_employee_mapping: translate(
      'auto.components.status.bar.TeamMemory.noEmployee',
      'no employee mapping'
    ),
    request_failed: translate(
      'auto.components.status.bar.TeamMemory.requestFailed',
      'request failed'
    ),
    not_loaded: translate(
      'auto.components.status.bar.TeamMemory.notInConnector',
      'not in connector'
    )
  }[status.reason]
  return {
    tone: 'attention',
    label: translate(
      'auto.components.status.bar.TeamMemory.notLoaded',
      'Team memory: not loaded — {{reason}}',
      { reason }
    ),
    detail: translate(
      'auto.components.status.bar.TeamMemory.notLoadedDetail',
      'Your agents are running without the team instructions. Click to re-check.'
    )
  }
}
