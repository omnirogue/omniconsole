import {
  accountSyncValueSize,
  ACCOUNT_SYNC_VALUE_MAX_BYTES,
  type AccountSyncReadResult,
  type AccountSyncWriteArgs,
  type AccountSyncWriteResult
} from '../../../../shared/account-sync-types'
import type { SessionFolderMetadata } from '@/lib/session-folders'
import {
  collectRemote,
  highestStamp,
  mergeSynced,
  type Synced
} from '../../../../shared/account-sync-session-docs'
import type { SessionOrganizationIntent } from './session-organization-intent'
import {
  localKeyDigest,
  mayBecomeSyncable,
  SESSION_SYNC_MAX_DOCS,
  SESSION_SYNC_SHARDS,
  type DeviceDocKind
} from '../../../../shared/account-sync-session-keys'
import { layout, plan, type Planned } from './session-sync-layout'
import { applySynced, type SyncIncomingHook } from './session-sync-apply'
import {
  authoredSyncStamps,
  isAuthoredHere,
  syncAppliedChanges,
  type SessionSyncOrganization
} from './session-sync-stamps'
import {
  adoptSyncedFolderIds,
  authorLocalEdits,
  projectLocal,
  type LocalSyncInput
} from './session-sync-local'

export type SessionSyncDeps = {
  read: () => Promise<AccountSyncReadResult>
  write: (args: AccountSyncWriteArgs) => Promise<AccountSyncWriteResult>
  local: {
    /** False until folders and the list's view have loaded for the signed-in scope. */
    ready: () => boolean
    /** Names this computer's scope (profile and account), which the sync state belongs to. */
    scope: () => string
    input: () => LocalSyncInput
    replaceMetadata: (metadata: SessionFolderMetadata) => void
    setArchived: (keys: string[], archived: boolean) => void
  }
  /** What the person did that the account has not recorded yet, settled once this computer has. */
  intent: {
    pending: (scope: string) => SessionOrganizationIntent
    settle: (scope: string, done: SessionOrganizationIntent) => void
  }
  newDevice: () => string
  storage: Pick<Storage, 'getItem' | 'setItem'>
  now: () => number
  /** Tells the person, once, about a problem that passes will not fix by retrying. */
  report: (problem: SessionSyncProblem) => void
  /** Ownership and records of what sync applies (session-sync-ownership); optional. */
  organization?: SessionSyncOrganization
}

export type SessionSyncProblem = { kind: 'too-large' } | { kind: 'refused'; message: string }

/** This computer's part: its id, what it authored, whether it has synced, its clock, its documents. */
type SyncState = {
  device: string
  authored: Synced
  adopted: boolean
  clock: number
  docs: Record<DeviceDocKind, number>
}

const STATE_KEY = 'omni.account-sync.v2'
const DEVICE = /^[0-9a-f]{8}$/
const FIRST_DOCS: Record<DeviceDocKind, number> = {
  folders: 1,
  sessions: SESSION_SYNC_SHARDS,
  projects: 1
}
/** Consecutive refusals of one document before the person is told. */
const REFUSALS_TO_REPORT = 3

const docCount = (value: unknown, kind: DeviceDocKind) =>
  typeof value === 'number' &&
  Number.isInteger(Math.log2(value)) &&
  value >= FIRST_DOCS[kind] &&
  value <= SESSION_SYNC_MAX_DOCS
    ? value
    : FIRST_DOCS[kind]

function loadState(deps: SessionSyncDeps, key: string): SyncState {
  try {
    const raw = deps.storage.getItem(key)
    const parsed = raw ? (JSON.parse(raw) as Partial<SyncState>) : null
    if (
      parsed?.device &&
      DEVICE.test(parsed.device) &&
      parsed.authored?.sessions &&
      parsed.authored.folders
    ) {
      return {
        device: parsed.device,
        authored: parsed.authored,
        adopted: parsed.adopted === true,
        clock: typeof parsed.clock === 'number' ? parsed.clock : 0,
        docs: {
          folders: docCount(parsed.docs?.folders, 'folders'),
          sessions: docCount(parsed.docs?.sessions, 'sessions'),
          projects: docCount(parsed.docs?.projects, 'projects')
        }
      }
    }
  } catch {
    // A damaged cache starts over as a new computer; nothing it held is lost from the account.
  }
  return {
    device: deps.newDevice(),
    authored: { sessions: {}, folders: {}, projects: {} },
    adopted: false,
    clock: 0,
    docs: { ...FIRST_DOCS }
  }
}

/**
 * Keeps this computer's session folders and archive state in step with the signed-in account's
 * other computers, through omnios' per-person preferences. A pass reads every computer's
 * documents, authors this computer's edits, applies everyone's, and rewrites only this computer's
 * own documents when omnios' copy is behind. Passes never overlap.
 */
export function createSessionAccountSync(deps: SessionSyncDeps) {
  let chain = Promise.resolve()
  let applying = false
  const reported = new Set<string>()
  const refusals = new Map<string, number>()

  function report(problem: SessionSyncProblem): void {
    if (!reported.has(problem.kind)) {
      reported.add(problem.kind)
      deps.report(problem)
    }
  }

  async function pass(): Promise<void> {
    if (!deps.local.ready()) {
      return
    }
    const scope = deps.local.scope()
    const remote = await deps.read()
    // Why: an answer read for another account or scope must never reach this one's folders.
    if (!remote.ok || deps.local.scope() !== scope || !deps.local.ready()) {
      return
    }
    const key = `${STATE_KEY}:${scope}:${remote.user}`
    const state = loadState(deps, key)
    const { all, stored } = collectRemote(remote.prefs, state.device)
    let merged = mergeSynced(all, state.authored)
    let clock = Math.max(state.clock, highestStamp(merged))
    const stamp = () => (clock = Math.max(deps.now(), clock + 1))
    const intent = deps.intent.pending(scope)
    let authored = state.authored
    let input: LocalSyncInput
    applying = true
    try {
      input = deps.local.input()
      if (!state.adopted) {
        const adopted = adoptSyncedFolderIds(input.metadata, merged.folders)
        if (adopted) {
          deps.local.replaceMetadata(adopted)
          input = deps.local.input()
        }
      }
      // A session the person just filed or archived counts even if it is no longer shown.
      const now = projectLocal(
        { ...input, present: [...input.present, ...intent.filed, ...intent.archived] },
        intent
      )
      const edits = authorLocalEdits({ merged, now, intent, stamp })
      const { organization } = deps
      // Why in this pass: its echo must already read as ours when the hook below sees it.
      organization?.noteAuthoredStamps(authoredSyncStamps(edits, now))
      authored = mergeSynced(authored, edits)
      merged = mergeSynced(merged, edits)
      const stamps = new Map<string, number>()
      const onIncoming: SyncIncomingHook | undefined =
        organization &&
        (({ digest, ...incoming }) => {
          stamps.set(`${incoming.field}\0${incoming.key}`, incoming.stamp)
          const mine = isAuthoredHere(authored, merged, digest, incoming.field)
          organization.onIncoming({ ...incoming, ours: mine })
        })
      const applied = applySynced(input, now, merged, onIncoming)
      if (applied.metadata) {
        deps.local.replaceMetadata(applied.metadata)
      }
      if (applied.archive.length) {
        deps.local.setArchived(applied.archive, true)
      }
      if (applied.unarchive.length) {
        deps.local.setArchived(applied.unarchive, false)
      }
      organization?.recordApplied(
        syncAppliedChanges({
          before: input.metadata,
          after: applied.metadata,
          archive: applied.archive,
          unarchive: applied.unarchive,
          stamps,
          folders: merged.folders,
          fallback: clock
        })
      )
    } finally {
      applying = false
    }
    const docs = {
      folders: layout('folders', authored.folders, state.docs.folders),
      sessions: layout('sessions', authored.sessions, state.docs.sessions),
      projects: layout('projects', authored.projects ?? {}, state.docs.projects)
    }
    const counts = {
      folders: docs.folders.count,
      sessions: docs.sessions.count,
      projects: docs.projects.count
    }
    deps.storage.setItem(
      key,
      JSON.stringify({ device: state.device, authored, adopted: true, clock, docs: counts })
    )
    // Recorded in this computer's state now, so it reaches the account on this or a later pass.
    // A pane not yet named by its provider session, or a session in a folder workspace not loaded
    // yet, keeps its change until it can sync.
    const recorded = (keys: Set<string>) =>
      new Set(
        [...keys].filter((id) => localKeyDigest(id, input.folderPaths) || !mayBecomeSyncable(id))
      )
    deps.intent.settle(scope, {
      ...intent,
      filed: recorded(intent.filed),
      archived: recorded(intent.archived)
    })
    await push(plan(state.device, remote.user, docs, stored))
  }

  async function send(write: AccountSyncWriteArgs): Promise<boolean | 'stop'> {
    if (accountSyncValueSize(write.value) > ACCOUNT_SYNC_VALUE_MAX_BYTES) {
      report({ kind: 'too-large' })
      return false
    }
    const result = await deps.write(write)
    if (result.ok) {
      refusals.delete(write.key)
      return true
    }
    // A changed account stops the pass; any other refusal is retried by the next pass.
    if (result.accountChanged) {
      return 'stop'
    }
    const count = (refusals.get(write.key) ?? 0) + 1
    refusals.set(write.key, count)
    if (count >= REFUSALS_TO_REPORT) {
      report({ kind: 'refused', message: result.message })
    }
    return false
  }

  /** Documents that only gain or update entries first; one that drops entries only after all land. */
  async function push(writes: Planned): Promise<void> {
    let landed = true
    for (const write of writes.adding) {
      const sent = await send(write)
      if (sent === 'stop') {
        return
      }
      landed &&= sent
    }
    if (!landed) {
      return
    }
    for (const write of writes.dropping) {
      if ((await send(write)) === 'stop') {
        return
      }
    }
  }

  /** One pass after any running one; failures wait for the next pass. */
  function run(): Promise<void> {
    chain = chain.then(pass).catch((error: unknown) => {
      console.warn('Session folder sync pass failed', error)
    })
    return chain
  }

  return {
    run,
    /** True while a pass writes its own changes into the local stores, so they are not echoed. */
    isApplying: () => applying
  }
}
