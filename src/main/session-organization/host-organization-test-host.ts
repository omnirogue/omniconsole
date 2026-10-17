/** A host organization service over a temp profile directory, reopened like a restarted process. */

import { join } from 'node:path'
import type { OrganizationExecutor } from '../../shared/session-organization-change'
import { SessionActionsLog } from '../session-manage/session-actions-log'
import { OrganizationChangeLedger } from './organization-change-ledger'
import {
  ORGANIZATION_HISTORY_DIRECTORY,
  OrganizationHistoryStore
} from './organization-history-store'
import { HostOrganizationOutbox } from './host-organization-outbox'
import {
  SessionOrganizationHost,
  type SessionOrganizationHostDeps
} from './host-organization-service'
import { HostOrganizationView } from './host-organization-view'

export const HOST_AGENT: OrganizationExecutor = {
  kind: 'pane',
  paneKey: 'tab-9:leaf-1',
  title: 'Steward'
}
export const HOST_PERSON: OrganizationExecutor = { kind: 'person', via: 'sidebar' }
export const FOLDER_ONE = '00000000-0000-4000-8000-000000000001'
export const FOLDER_TWO = '00000000-0000-4000-8000-000000000002'
/** A sidebar key with a canonical provider identity, so it has an account-sync digest. */
export const SYNCED_KEY = JSON.stringify([
  'local',
  'provider',
  'repo-1::/work/app\0claude\0claude\0session-1'
])

export type OpenedHost = {
  host: SessionOrganizationHost
  ledger: OrganizationChangeLedger
  view: HostOrganizationView
  outbox: HostOrganizationOutbox
}

/** A clock that moves a second per read, and op ids `op-1`, `op-2`… per test. */
export function hostTestClock(start = Date.UTC(2026, 8, 26, 9)) {
  let seconds = 0
  let ops = 0
  return {
    now: () => new Date(start + (seconds += 1) * 1000),
    mintOpId: () => `op-${(ops += 1)}`,
    peek: () => start + seconds * 1000
  }
}

export function openTestHost(
  dir: string,
  clock: ReturnType<typeof hostTestClock>,
  extra: Partial<SessionOrganizationHostDeps> = {}
): OpenedHost {
  const directory = join(dir, ORGANIZATION_HISTORY_DIRECTORY)
  const store = new OrganizationHistoryStore({ directory })
  store.load()
  const ledger = new OrganizationChangeLedger({
    trail: new SessionActionsLog(dir, clock.now),
    store,
    now: clock.now
  })
  const view = new HostOrganizationView({ directory })
  view.load()
  const outbox = new HostOrganizationOutbox({ directory })
  outbox.load()
  const host = new SessionOrganizationHost({
    ledger,
    view,
    outbox,
    now: clock.now,
    mintOpId: clock.mintOpId,
    ...extra
  })
  return { host, ledger, view, outbox }
}
