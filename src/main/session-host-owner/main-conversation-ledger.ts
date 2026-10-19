/**
 * The owner's conversation ledger while no window publishes it (session parity, step 3), modelled
 * on headless-session-archive.ts. Existence and rest come from the main inventory (the persisted
 * LOCAL partition, the window's ownership classifier and connected PTYs: addendum B2, F16); the
 * folder and project catalog, titles and listing time from the last window publication, kept in
 * owner-ledger.json across restarts (F17); archive, placement and hidden from the host organization
 * values with their stamps, never the capped history — the newer of the value's stamp and the last
 * listing wins, and a field neither knows stays absent (F5). A deleted tab-less conversation is
 * left out, as the sidebar leaves it out (B1). It is `source: 'main'`: it adds, updates and vouches,
 * and its omissions remove nothing on a receiver. Rebuilt, coalesced, on every change to the host
 * values and on every store write and PTY spawn or exit the runtime notes (F6).
 */

import {
  readSessionConversationLedgerPublication,
  type RuntimeSessionConversationRecord,
  type SessionConversationLedgerWindowPublication
} from '../../shared/session-conversation-ledger'
import { SAVED_SESSIONS_REF_ID } from '../../shared/session-folder-ref'
import type {
  HostOrganizationEntry,
  HostOrganizationField
} from '../../shared/session-organization-host'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type {
  SessionConversationLedgerMainSet,
  SessionConversationLedgerStore
} from '../runtime/session-conversation-ledger-store'
import {
  sessionOrganizationValuesFor,
  type HostOrganizationValuesReader
} from '../session-organization/host-organization-instance'
import { publishConversationLedgerRemovals } from './conversation-ledger-removals'
import {
  mainConversationInventory,
  type MainConversationInventory,
  type MainInventoryConversation,
  type OwnerConversationInventorySource
} from './main-conversation-inventory'

// Why the window publisher's coalescing: a burst of writes (a sleep, a restore) costs one build.
const REPUBLISH_COALESCE_MS = 100

type Organization = Pick<
  RuntimeSessionConversationRecord,
  'archived' | 'folderId' | 'saved' | 'hidden' | 'agentSession'
>

const recordKey = (worktreeId: string, identity: string) => JSON.stringify([worktreeId, identity])

/** The last window listing's records, by conversation digest and by pane identity. */
function rememberedRecords(
  last: SessionConversationLedgerWindowPublication | null
): Map<string, RuntimeSessionConversationRecord> {
  const remembered = new Map<string, RuntimeSessionConversationRecord>()
  for (const [worktreeId, records] of Object.entries(last?.recordsByWorktree ?? {})) {
    for (const record of records) {
      for (const identity of [record.conversation, record.paneIdentity]) {
        if (identity) {
          remembered.set(recordKey(worktreeId, identity), record)
        }
      }
    }
  }
  return remembered
}

/**
 * The listing's record for this conversation. Why a pane match only for a provider-less listing: a
 * pane outlives its conversations, so a listed digest other than this one is another conversation.
 */
function rememberedFor(
  conversation: MainInventoryConversation,
  remembered: Map<string, RuntimeSessionConversationRecord>
): RuntimeSessionConversationRecord | undefined {
  const byPane = remembered.get(recordKey(conversation.worktreeId, conversation.paneIdentity))
  if (!conversation.conversation) {
    return byPane
  }
  const byDigest = remembered.get(recordKey(conversation.worktreeId, conversation.conversation))
  return byDigest ?? (byPane?.conversation === null ? byPane : undefined)
}

/** Whether the host value of a field decides: it is newer than the listing, or all there is. */
function hostDecides(
  entry: HostOrganizationEntry | undefined,
  field: HostOrganizationField,
  listedAt: number,
  rememberedKnows: boolean
): boolean {
  const at = Date.parse(entry?.stamps?.[field] ?? '')
  return (
    Number.isFinite(at) &&
    entry !== undefined &&
    Object.hasOwn(entry.values, field) &&
    (!rememberedKnows || at > listedAt)
  )
}

function organizationOf(
  entry: HostOrganizationEntry | undefined,
  remembered: RuntimeSessionConversationRecord | undefined,
  last: SessionConversationLedgerWindowPublication | null
): Organization {
  const listedAt = last?.listedAt ?? 0
  const values = entry?.values ?? {}
  const out: Organization = {}
  if (hostDecides(entry, 'archived', listedAt, remembered?.archived !== undefined)) {
    // Why no `byHand`: the value says whether, not who; absent reads "the owner did not say".
    out.archived = { archived: values.archived === true }
  } else if (remembered?.archived) {
    out.archived = remembered.archived
  }
  if (hostDecides(entry, 'placement', listedAt, remembered?.folderId !== undefined)) {
    const placement = values.placement ?? null
    out.folderId = placement
    out.saved =
      placement === SAVED_SESSIONS_REF_ID ||
      (last?.folders ?? []).some((folder) => folder.id === placement && folder.section === 'saved')
  } else {
    if (remembered?.folderId !== undefined) {
      out.folderId = remembered.folderId
    }
    if (remembered?.saved !== undefined) {
      out.saved = remembered.saved
    }
  }
  if (hostDecides(entry, 'hidden', listedAt, remembered?.hidden !== undefined)) {
    out.hidden = values.hidden === true
  } else if (remembered?.hidden !== undefined) {
    out.hidden = remembered.hidden
  }
  // Why the listing: only the window knows an agent launched it, and that never changes.
  if (remembered?.agentSession && out.saved !== true) {
    out.agentSession = true
  }
  return out
}

function titleOf(
  conversation: MainInventoryConversation,
  entry: HostOrganizationEntry | undefined,
  remembered: RuntimeSessionConversationRecord | undefined,
  listedAt: number
): Pick<RuntimeSessionConversationRecord, 'title' | 'titleSource'> {
  // Why typeof: host-values.json is read unvalidated, and a damaged value must not throw.
  const raw: unknown = entry?.values.title
  const named = typeof raw === 'string' ? raw.trim() : ''
  if (named && hostDecides(entry, 'title', listedAt, remembered !== undefined)) {
    return {
      title: named,
      titleSource: entry?.values.titleOrigin === 'generated' ? 'generated' : 'custom'
    }
  }
  return remembered
    ? { title: remembered.title, titleSource: remembered.titleSource }
    : { title: conversation.title, titleSource: conversation.titleSource }
}

/** The main-authored set: the main inventory overlaid with the owner's organization and titles. */
export function mainConversationLedger(input: {
  inventory: MainConversationInventory
  lastWindow: SessionConversationLedgerWindowPublication | null
  values: Pick<HostOrganizationValuesReader, 'entry'>
}): SessionConversationLedgerMainSet {
  const { inventory, lastWindow, values } = input
  const remembered = rememberedRecords(lastWindow)
  const listedAt = lastWindow?.listedAt ?? 0
  const recordsByWorktree: Record<string, RuntimeSessionConversationRecord[]> = {}
  let unverified = 0
  for (const conversation of inventory.conversations) {
    const entry = values.entry(conversation.viewKey)
    // Why tab-less only: a deleted conversation whose tab is open again is listed again.
    if (conversation.surface === 'record' && entry?.values.deleted === true) {
      continue
    }
    const { worktreeId } = conversation
    // Why (F3): only an owned workspace vouches for a row, as the window's rule says; one recorded
    // on more than one computer is counted, even where a local PTY made the tab itself owned.
    if (inventory.workspaces.get(worktreeId)?.provenance !== 'owned') {
      unverified += 1
      continue
    }
    const known = rememberedFor(conversation, remembered)
    // Why the listed identity when main knows none: a row must not change identity on a peer
    // because the window closed (main omissions remove nothing, so it would show twice).
    const identity =
      conversation.conversation || !known?.conversation
        ? {
            conversation: conversation.conversation,
            agent: conversation.agent,
            providerSession: conversation.providerSession
              ? { key: conversation.providerSession.key, id: conversation.providerSession.id }
              : null
          }
        : {
            conversation: known.conversation,
            agent: known.agent,
            providerSession: known.providerSession
          }
    const record: RuntimeSessionConversationRecord = {
      ...identity,
      paneIdentity: conversation.paneIdentity,
      ...titleOf(conversation, entry, known, listedAt),
      surface: conversation.surface,
      paneKey: conversation.paneKey,
      ...(conversation.tabId ? { tabId: conversation.tabId } : {}),
      rest: conversation.rest,
      // Why asleep only: as the window publishes it; a running pane's old record is no interruption.
      ...(conversation.interrupted && conversation.rest === 'asleep'
        ? { interrupted: true as const }
        : {}),
      ...organizationOf(entry, known, lastWindow),
      listed: conversation.listed,
      updatedAt: Math.max(conversation.updatedAt, known?.updatedAt ?? 0)
    }
    ;(recordsByWorktree[worktreeId] ??= []).push(record)
  }
  const coverage = [...inventory.workspaces].flatMap(([worktreeId, workspace]) => {
    unverified += workspace.quarantined
    const owned = workspace.provenance === 'owned'
    // Why: a paired runtime's workspace is not this owner's to speak for, unless rows were held.
    return workspace.provenance === 'peer' && workspace.quarantined === 0
      ? []
      : [
          {
            worktreeId,
            complete: owned && workspace.quarantined === 0 && !workspace.connectionBound
          }
        ]
  })
  const set: SessionConversationLedgerMainSet = {
    listedAt,
    coverage,
    omitted: { unknownHost: 0, unverified },
    folders: lastWindow?.folders ?? [],
    projects: lastWindow?.projects ?? [],
    recordsByWorktree
  }
  // Why read back through the contract: caps, bounds and duplicate identities hold as for a window.
  const read = readSessionConversationLedgerPublication({ rendererGeneration: 'main', ...set })
  if (!read) {
    return set
  }
  const { rendererGeneration: _main, ...body } = read
  return body
}

export type MainConversationLedgerDeps = {
  store: Pick<
    SessionConversationLedgerStore,
    'publishMain' | 'isWindowCurrent' | 'lastWindowPublication' | 'onChange'
  >
  /** The runtime's persisted LOCAL partition and live PTYs; null with no store. */
  readInventory(): OwnerConversationInventorySource | null
  values: HostOrganizationValuesReader
  /** The runtime's store writes and PTY spawns and exits. */
  onInventoryChanged(listener: () => void): () => void
}

/** Publishes the main-authored set while no window is current; returns the stop. */
export function publishMainConversationLedger(deps: MainConversationLedgerDeps): () => void {
  const { store } = deps
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let windowWasCurrent = store.isWindowCurrent()
  const build = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    // Why caught: this runs inline in app startup and in timers and microtasks, where a throw on a
    // damaged persisted value would abort startup or crash main; the last set stands instead.
    try {
      const source = stopped || store.isWindowCurrent() ? null : deps.readInventory()
      // Why nothing without a store: the last window records, every workspace incomplete, stand.
      if (source) {
        store.publishMain(
          mainConversationLedger({
            inventory: mainConversationInventory(source),
            lastWindow: store.lastWindowPublication(),
            values: deps.values
          })
        )
      }
    } catch (error) {
      console.warn('[session-host] building the main-authored conversation ledger failed', error)
    }
  }
  const schedule = (): void => {
    if (!stopped && timer === null && !store.isWindowCurrent()) {
      timer = setTimeout(build, REPUBLISH_COALESCE_MS)
      timer.unref?.()
    }
  }
  const stops = [
    deps.values.onChange(schedule),
    deps.onInventoryChanged(schedule),
    store.onChange(() => {
      const current = store.isWindowCurrent()
      // Why at once: the window going away shows the kept main set, which may be old.
      if (windowWasCurrent && !current) {
        queueMicrotask(build)
      }
      windowWasCurrent = current
    })
  ]
  build()
  return () => {
    stopped = true
    if (timer !== null) {
      clearTimeout(timer)
    }
    for (const stop of stops) {
      stop()
    }
  }
}

/**
 * The owner runtime's conversation ledger halves main authors: tombstones and the windowless set.
 * The stop resolves once owner-ledger.json holds the window's last publication (F17), whose write
 * is otherwise coalesced on a timer that a quit would outrun.
 */
export function startOwnerConversationLedger(
  runtime: Pick<
    OrcaRuntimeService,
    | 'getSessionConversationLedgerStore'
    | 'readOwnerConversationInventory'
    | 'onOwnerConversationInventoryChanged'
  >,
  userDataPath: string
): () => Promise<void> {
  const store = runtime.getSessionConversationLedgerStore()
  const values = sessionOrganizationValuesFor(userDataPath)
  const stops = [
    publishConversationLedgerRemovals(store, values),
    publishMainConversationLedger({
      store,
      readInventory: () => runtime.readOwnerConversationInventory(),
      values,
      onInventoryChanged: (listener) => runtime.onOwnerConversationInventoryChanged(listener)
    }),
    // Why last: the runtime advertises the ledger only once its publishers run.
    store.installOwnerPublisher()
  ]
  return () => {
    stops.forEach((stop) => stop())
    return store.flushOwnerLedger()
  }
}
