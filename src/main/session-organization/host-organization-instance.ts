/**
 * One host organization service per profile directory, over that directory's ledger, so the
 * window's changes, the host's own and the RPCs all share one history. The window binding is
 * filled in once the runtime exists; until then (and in a process with no window) changes
 * commit headlessly.
 */

import { join } from 'node:path'
import {
  SESSION_FOLDERS_NO_WINDOW_ERROR,
  type SessionFolderRelayRequest
} from '../../shared/session-folder-cli'
import { sessionOrganizationLedgerFor } from './organization-change-ledger'
import { ORGANIZATION_HISTORY_DIRECTORY } from './organization-history-store'
import type { OrganizationRelay } from './organization-relayed-mutation'
import { HostOrganizationOutbox } from './host-organization-outbox'
import { SessionOrganizationHost } from './host-organization-service'
import { HostOrganizationView } from './host-organization-view'

export type HostOrganizationWindowBinding = {
  relay?: OrganizationRelay
  windowAttached?: () => boolean
}

const hosts = new Map<
  string,
  {
    host: SessionOrganizationHost
    view: HostOrganizationView
    binding: HostOrganizationWindowBinding
  }
>()

/** The folded values a profile's host keeps (host-values.json), read-only, with their stamps. */
export type HostOrganizationValuesReader = Pick<HostOrganizationView, 'entry' | 'keys' | 'onChange'>

function instance(userDataPath: string) {
  let found = hosts.get(userDataPath)
  if (!found) {
    const directory = join(userDataPath, ORGANIZATION_HISTORY_DIRECTORY)
    const view = new HostOrganizationView({ directory })
    view.load()
    const outbox = new HostOrganizationOutbox({ directory })
    outbox.load()
    const binding: HostOrganizationWindowBinding = {}
    const host = new SessionOrganizationHost({
      ledger: sessionOrganizationLedgerFor(userDataPath),
      view,
      outbox,
      relay: (request: SessionFolderRelayRequest) =>
        binding.relay
          ? binding.relay(request)
          : Promise.reject(new Error(SESSION_FOLDERS_NO_WINDOW_ERROR)),
      windowAttached: () => binding.windowAttached?.() ?? false
    })
    found = { host, view, binding }
    hosts.set(userDataPath, found)
  }
  return found
}

export function sessionOrganizationHostFor(userDataPath: string): SessionOrganizationHost {
  return instance(userDataPath).host
}

/**
 * The current organization values with their per-field stamps (session parity, F5): the owner's
 * conversation ledger reads these, never the capped history. `onChange` fires once a change holds
 * in memory: an applied record is heard after the host folded it, an import as it lands.
 */
export function sessionOrganizationValuesFor(userDataPath: string): HostOrganizationValuesReader {
  return instance(userDataPath).view
}

/** Lets the host apply through this process's window while one is attached. */
export function bindSessionOrganizationHostWindow(
  userDataPath: string,
  binding: HostOrganizationWindowBinding
): void {
  Object.assign(instance(userDataPath).binding, binding)
}
