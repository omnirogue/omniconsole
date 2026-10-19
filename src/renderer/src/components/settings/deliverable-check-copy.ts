import { translate } from '@/i18n/i18n'
import type { DeliverableVerifierMode } from '../../../../shared/deliverable-verifier-settings'
import { searchKeywords } from './settings-search-keywords'

export function getDeliverableCheckTitle(): string {
  return translate('deliverableCheck.settings.title', 'Deliverable check')
}

export function getDeliverableCheckDescription(): string {
  return translate(
    'deliverableCheck.settings.description',
    'When a session finishes, check that the files it was asked for, and the files and links it says it made, exist where they should.'
  )
}

export function getDeliverableCheckModeLabel(mode: DeliverableVerifierMode): string {
  if (mode === 'shadow') {
    return translate('deliverableCheck.settings.mode.shadow', 'Watch only')
  }
  if (mode === 'on') {
    return translate('deliverableCheck.settings.mode.on', 'Check and ask to finish')
  }
  return translate('deliverableCheck.settings.mode.off', 'Off')
}

export function getDeliverableCheckModeDetail(
  mode: DeliverableVerifierMode,
  repairs: number
): string {
  if (mode === 'shadow') {
    return translate(
      'deliverableCheck.settings.detail.shadow',
      'Check what each session was asked for and says it produced. Nothing is sent.'
    )
  }
  if (mode === 'on') {
    return translate(
      'deliverableCheck.settings.detail.on',
      'If something is missing, ask the same agent to finish it, up to {{count}} times per request.',
      { count: repairs }
    )
  }
  return translate('deliverableCheck.settings.detail.off', 'Sessions are not checked.')
}

export function getDeliverableCheckRepairsLabel(): string {
  return translate('deliverableCheck.settings.repairs', 'Times to ask per request')
}

export function getDeliverableCheckSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'deliverableCheck.search.deliverable', fallback: 'deliverable' },
    { key: 'deliverableCheck.search.verify', fallback: 'verify' },
    { key: 'deliverableCheck.search.missing', fallback: 'missing' },
    { key: 'deliverableCheck.search.retry', fallback: 'retry' },
    { key: 'deliverableCheck.search.files', fallback: 'files' },
    { key: 'deliverableCheck.search.finish', fallback: 'finish' }
  ])
}
