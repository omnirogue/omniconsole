import type {
  DeliverableCheck,
  DeliverableVerdict,
  DeliverableVerificationRecord
} from '../../../../../shared/deliverable-verification-types'
import { translate } from '@/i18n/i18n'

function checkedLine(found: number, total: number): string {
  return translate('deliverableCheck.panel.checked', 'Checked: {{found}} of {{total}} found', {
    found,
    total
  })
}

/** The block's one status line, from the newest record: what was found and what happened next. */
export function deliverableStatusLine(record: DeliverableVerificationRecord): string {
  const total = record.checks.length
  const found = record.checks.filter((check) => check.verdict === 'verified').length
  const missing = record.checks.filter((check) => check.verdict === 'missing').length
  switch (record.action) {
    case 'repair-sent':
      return translate(
        'deliverableCheck.panel.asking',
        'Asking the agent to finish ({{n}} of {{max}})',
        { n: record.repairsSent, max: record.maxRepairs }
      )
    case 'would-repair':
      return translate(
        'deliverableCheck.panel.wouldAsk',
        'Would ask the agent to finish {{count}} item',
        { count: missing }
      )
    case 'stopped:no-progress':
      return translate(
        'deliverableCheck.panel.noProgress',
        'Stopped: the last repair changed nothing'
      )
    case 'exhausted':
      return translate('deliverableCheck.panel.exhausted', '{{count}} deliverables still missing', {
        count: missing
      })
    case 'none':
      return checkedLine(found, total)
    default:
      // The only actions left are `skipped:<reason>`.
      return missing > 0
        ? translate('deliverableCheck.panel.skipped', '{{count}} missing; not asked ({{why}})', {
            count: missing,
            why: record.action.slice('skipped:'.length).replace(/-/g, ' ')
          })
        : checkedLine(found, total)
  }
}

export function deliverableVerdictLabel(verdict: DeliverableVerdict): string {
  switch (verdict) {
    case 'verified':
      return translate('deliverableCheck.panel.verdict.verified', 'Verified')
    case 'missing':
      return translate('deliverableCheck.panel.verdict.missing', 'Missing')
    case 'declined':
      return translate('deliverableCheck.panel.verdict.declined', 'Declined')
    case 'unverifiable':
      return translate('deliverableCheck.panel.verdict.unverifiable', "Can't check")
  }
}

export function deliverableSourceLabel(check: DeliverableCheck): string {
  switch (check.source) {
    case 'request':
      return translate('deliverableCheck.panel.source.request', 'asked for')
    case 'prep':
      return translate('deliverableCheck.panel.source.prep', 'Done when')
    case 'mission':
      return translate('deliverableCheck.panel.source.mission', 'mission')
    case 'claim':
      return translate('deliverableCheck.panel.source.claim', 'reply says {{claim}}', {
        claim: check.claim
      })
  }
}

export function deliverableHostLabel(host: string): string {
  return host === 'local'
    ? translate('deliverableCheck.panel.host.local', 'this computer')
    : translate('deliverableCheck.panel.host.ssh', 'SSH host')
}
