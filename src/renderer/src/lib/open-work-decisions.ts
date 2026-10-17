import { useAppStore } from '@/store'
import { resolveBackofficeBaseUrl } from '../../../shared/backoffice-connection'
import { openHttpLink } from './http-link-routing'

export function openWorkDecisions(): void {
  const connection = resolveBackofficeBaseUrl(useAppStore.getState().settings ?? {})
  if (connection.configured) {
    openHttpLink(`${connection.baseUrl}/work/decisions`, { forceSystemBrowser: true })
  }
}
