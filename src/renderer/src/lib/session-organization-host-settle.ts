/**
 * At start, once sessions are restored: adopt the changes this computer's host committed while
 * no window was open, then hand main the window's current values so its host values match and it
 * can admit automation (docs/reference/session-host-control.md). Account sync waits for this,
 * so a pass never reads the pre-adoption values as another computer's change.
 */

import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionTags } from '@/store/session-tags'
import { useWaitLater } from '@/store/wait-later-store'
import { localKeyDigest, type FolderPaths } from '../../../shared/account-sync-session-keys'
import type { OrganizationRecord } from '../../../shared/session-organization-change'
import type {
  HostOrganizationMigrationEntry,
  HostOrganizationValues
} from '../../../shared/session-organization-host'
import {
  HOST_ORGANIZATION_MIGRATION_BATCH,
  SESSION_ORGANIZATION_HOST_RPC
} from '../../../shared/session-organization-host-schema'
import { conversationViewKey } from './conversation-view'
import type { OrganizationRpc } from './session-organization-change-contract'
import { adoptHostOrganizationChanges } from './session-organization-host-adoption'
import { appTitleStore, type OrganizationTitleStore } from './session-organization-title'
import { readOrganizationValue, type OrganizationStores } from './session-organization-values'
import { getSessionFolderId } from './session-folders'
import { sessionTagIds } from './session-tags'
import { buildSidebarSessions } from './sidebar-sessions'

/** Past this, account sync runs anyway: a window that never restores must not stop syncing. */
export const HOST_ORGANIZATION_SETTLE_WAIT_MS = 60_000

const startedAt = Date.now()
let settled = false
const settledListeners = new Set<() => void>()

export function isHostOrganizationSettled(): boolean {
  return settled || Date.now() - startedAt > HOST_ORGANIZATION_SETTLE_WAIT_MS
}

/** Hears the hand-over finish (so sync can run its first pass then); returns the unsubscribe. */
export function onHostOrganizationSettled(listener: () => void): () => void {
  settledListeners.add(listener)
  return () => settledListeners.delete(listener)
}

export type HostOrganizationSession = { key: string; tabId: string | null }

const HIDDEN_PREFIXES = ['conversation:', 'session:']

/** Every key the window holds organization for, with what it holds now. */
export function hostOrganizationExport(input: {
  stores: OrganizationStores
  sessions: readonly HostOrganizationSession[]
  folderPaths: FolderPaths
  titles: OrganizationTitleStore
}): HostOrganizationMigrationEntry[] {
  const { stores, sessions, folderPaths, titles } = input
  const { metadata } = stores.folders.getState()
  const view = stores.view.getState()
  const tags = stores.tags?.getState()
  const tabs = new Map(sessions.map((session) => [session.key, session.tabId]))
  const keys = new Set<string>([
    ...sessions.map((session) => session.key),
    ...Object.keys(metadata.membership),
    ...view.archived,
    ...view.view.hidden.flatMap((entry) =>
      HIDDEN_PREFIXES.filter((prefix) => entry.startsWith(prefix)).map((prefix) =>
        entry.slice(prefix.length)
      )
    ),
    ...Object.keys(tags?.loaded ? tags.data.assignments : {})
  ])
  return [...keys].map((key) => {
    const target = { sessionKey: key }
    const read = (kind: 'hide' | 'snooze') => readOrganizationValue(kind, target, stores, true)
    const hidden = read('hide')
    const snooze = read('snooze')
    const tabId = tabs.get(key)
    const title = tabId ? titles.read(tabId) : { known: false as const }
    const values: Partial<HostOrganizationValues> = {
      placement: getSessionFolderId(metadata, key),
      archived: view.archived.includes(key),
      ...(hidden.known ? { hidden: hidden.value === true } : {}),
      ...(snooze.known ? { snooze: typeof snooze.value === 'number' ? snooze.value : null } : {}),
      ...(tags?.loaded ? { tags: sessionTagIds(tags.data, key, null) } : {}),
      ...(title.known
        ? { title: title.title, ...(title.origin ? { titleOrigin: title.origin } : {}) }
        : {})
    }
    const digest = localKeyDigest(key, folderPaths)
    return { key, ...(digest ? { digest } : {}), values }
  })
}

/**
 * The window's deletion marks, for main's durable `deleted` value (session parity, F4): every
 * deleted key true, every other key the window exported false (main records a false only where it
 * already holds the field). Sent after the values above, in batches of their own, because the
 * migrate schema is strict: an older main refuses these alone and has imported the rest.
 */
export function hostOrganizationDeletionExport(
  stores: Pick<OrganizationStores, 'view'>,
  exported: readonly Pick<HostOrganizationMigrationEntry, 'key'>[]
): HostOrganizationMigrationEntry[] {
  const deleted = new Set(stores.view.getState().view.deleted ?? [])
  const keys = new Set([...exported.map((entry) => entry.key), ...deleted])
  return [...keys].map((key) => ({ key, values: { deleted: deleted.has(key) } }))
}

async function handOverDeletionMarks(
  rpc: OrganizationRpc,
  entries: readonly HostOrganizationMigrationEntry[]
): Promise<void> {
  try {
    for (let start = 0; start < entries.length; start += HOST_ORGANIZATION_MIGRATION_BATCH) {
      const batch = entries.slice(start, start + HOST_ORGANIZATION_MIGRATION_BATCH)
      await rpc(SESSION_ORGANIZATION_HOST_RPC.migrate, { entries: batch })
    }
  } catch (error) {
    // Why apart: an older main keeps no deletion marks; everything else was handed over already.
    console.warn('[session-organization] main did not take the deletion marks', error)
  }
}

export type HostOrganizationSettleDeps = {
  rpc?: OrganizationRpc
  stores?: OrganizationStores
  sessions?: () => HostOrganizationSession[]
  folderPaths?: () => FolderPaths
  titles?: OrganizationTitleStore
}

const localRpc: OrganizationRpc = (method, params) =>
  callRuntimeRpc({ kind: 'local' }, method, params)

function appSessions(): HostOrganizationSession[] {
  return buildSidebarSessions(useAppStore.getState()).map((session) => ({
    key: conversationViewKey(session),
    tabId: session.tabId
  }))
}

function appFolderPaths(): FolderPaths {
  return Object.fromEntries(
    useAppStore.getState().folderWorkspaces.map((workspace) => [workspace.id, workspace.folderPath])
  )
}

/** Best effort: an older main or a failed call leaves sync to run as before. */
export async function settleHostOrganization(deps: HostOrganizationSettleDeps = {}): Promise<void> {
  const rpc = deps.rpc ?? localRpc
  const stores = deps.stores ?? {
    folders: useSessionFolders,
    view: useSessionSidebarView,
    tags: useSessionTags,
    waitLater: useWaitLater
  }
  const sessions = (deps.sessions ?? appSessions)()
  try {
    const pending = await rpc<{ records?: OrganizationRecord[] }>(
      SESSION_ORGANIZATION_HOST_RPC.pending
    )
    const records = pending?.records ?? []
    if (records.length > 0) {
      const tabs = new Map(sessions.map((session) => [session.key, session.tabId]))
      const { adopted, conflicts } = adoptHostOrganizationChanges(
        records,
        stores,
        (key) => tabs.get(key) ?? null
      )
      await rpc(SESSION_ORGANIZATION_HOST_RPC.adopted, { adopted, conflicts })
    }
    const entries = hostOrganizationExport({
      stores,
      sessions,
      folderPaths: (deps.folderPaths ?? appFolderPaths)(),
      titles: deps.titles ?? appTitleStore
    })
    for (
      let start = 0;
      start === 0 || start < entries.length;
      start += HOST_ORGANIZATION_MIGRATION_BATCH
    ) {
      const batch = entries.slice(start, start + HOST_ORGANIZATION_MIGRATION_BATCH)
      const complete = start + HOST_ORGANIZATION_MIGRATION_BATCH >= entries.length
      await rpc(SESSION_ORGANIZATION_HOST_RPC.migrate, { entries: batch, complete })
    }
    await handOverDeletionMarks(rpc, hostOrganizationDeletionExport(stores, entries))
  } catch (error) {
    console.warn('[session-organization] handing organization to the host failed', error)
  } finally {
    settled = true
    for (const listener of settledListeners) {
      listener()
    }
  }
}
