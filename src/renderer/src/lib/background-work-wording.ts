import { translate } from '@/i18n/i18n'

/**
 * A finished turn whose background shells, tasks or agents still run: waiting, never working. One
 * wording and casing for every surface that shows it.
 */
export function backgroundWorkLine(count: number | undefined): string {
  return count
    ? translate('conversations.monitorWaitingCount', 'Waiting on background work ({{count}})', {
        count
      })
    : translate('conversations.monitorWaiting', 'Waiting on background work')
}
