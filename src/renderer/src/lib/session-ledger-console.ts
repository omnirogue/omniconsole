import { useAppStore } from '@/store'
import { openHttpLink } from './http-link-routing'
import { resolveBackofficeBaseUrl } from '../../../shared/backoffice-connection'

export function openSessionLedgerConsole(ledgerId?: string): void {
  const connection = resolveBackofficeBaseUrl(useAppStore.getState().settings ?? {})
  if (!connection.configured) {
    return
  }
  const url = `${connection.baseUrl}/sessions${ledgerId ? `?ledger=${encodeURIComponent(ledgerId)}` : ''}`
  openHttpLink(url, { forceSystemBrowser: true })
}
