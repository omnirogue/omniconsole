import { updateDoneArchiveClocks, watchDoneArchiveClocks } from './session-done-archive-clock'
import { updateUnreachableBlankClocksNow } from './session-unreachable-blank-clocks'
import { applyWhenFinished } from './session-when-finished'
import { applyAutomaticSessionArchives } from './session-auto-archive'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { hostSessionFinishChoice } from './session-finish-host-choice'
import { applyHostSessionDisposition } from './session-finish-disposition'
import { applyLegacySessionFinishAction } from './session-finish-legacy'
import { outcomeOwnerKey } from './session-outcome-owner'
import type { SessionChain } from '../../../shared/session-chain-types'
import { useEffect } from 'react'
import { openCommandCenter } from './command-center-navigation'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { conversationViewKey } from './conversation-view'
import {
  SAVED_SESSIONS_FOLDER_ID,
  isSavedSessionFolder,
  type SessionFinishAction
} from './session-folders'
import {
  getAllSessionChainEntries,
  findShownSessionChainForRow,
  subscribeSessionChains
} from './session-chain-registry'
import { buildSidebarSessions, type SidebarSession } from './sidebar-sessions'
import type { OrganizationExecutor } from '../../../shared/session-organization-change'
import {
  appExecutor,
  applyPersonStoreChange,
  applyRecordedChange,
  finishKeepChange,
  finishSaveChange,
  noteKeptForMe
} from './session-organization-app-changes'

const BY_WORK: OrganizationExecutor = { kind: 'person', via: 'work' }
const BY_FINISH = appExecutor('finish')
const finishStores = () => ({ folders: useSessionFolders, view: useSessionSidebarView })

export function readSessionFinishAction(
  session: SidebarSession,
  chain?: SessionChain
): SessionFinishAction {
  const folders = useSessionFolders.getState()
  if (!folders.loaded) {
    folders.load()
  }
  const current =
    useSessionFolders.getState().metadata.finishActions?.[conversationViewKey(session)]
  const host = chain ?? findShownSessionChainForRow(session.rowKey)
  const hostChoice = host ? hostSessionFinishChoice(session, host, current) : undefined
  // A mirror of this very chain whose host no longer records a finish is stale: nothing is chosen.
  const mirror =
    host?.outcomeSet && !host.outcomeSet.sessionFinish && current?.chainId === host.id
      ? undefined
      : current
  return hostChoice ?? mirror ?? { action: 'me', folderId: SAVED_SESSIONS_FOLDER_ID }
}

export function scheduleSessionFinish(
  session: SidebarSession,
  choice: SessionFinishAction,
  chain: SessionChain
): void {
  if (
    !useSessionFolders.getState().setFinishAction(conversationViewKey(session), {
      ...choice,
      chainId: chain.id,
      executionOwnerKey: outcomeOwnerKey(chain),
      revision: chain.outcomeSet!.revision,
      applied: false
    })
  ) {
    throw new Error(
      'The outcome was saved, but the session finish choice could not be saved on this device. Try saving again.'
    )
  }
}

function loadedFolders(): void {
  const folders = useSessionFolders.getState()
  if (!folders.loaded) {
    folders.load()
  }
}

/** The person's "keep it for me" (✓ Done): applied now, recorded after. */
export function keepFinishedSessionForMe(
  session: SidebarSession,
  choice: SessionFinishAction
): boolean {
  loadedFolders()
  const key = conversationViewKey(session)
  const change = finishKeepChange(key, choice, BY_WORK, finishStores())
  return change ? applyPersonStoreChange(change) : noteKeptForMe(key, choice, finishStores())
}

/** The same when a finished run carries it out: recorded before it runs. */
async function keepFinishedSessionForMeByApp(
  session: SidebarSession,
  choice: SessionFinishAction
): Promise<boolean> {
  loadedFolders()
  const key = conversationViewKey(session)
  const change = finishKeepChange(key, choice, BY_FINISH, finishStores())
  return change
    ? (await applyRecordedChange(change)).ok
    : noteKeptForMe(key, choice, finishStores())
}

function finishSaveDestination(folderId: string | null): string {
  const { metadata } = useSessionFolders.getState()
  return (isSavedSessionFolder(metadata, folderId) ? folderId : null) ?? SAVED_SESSIONS_FOLDER_ID
}

function leaveSavedSession(session: SidebarSession): void {
  const state = useAppStore.getState()
  if (
    state.activeTabId === session.tabId &&
    state.activeWorktreeId === session.worktreeId &&
    state.activeView === 'terminal'
  ) {
    openCommandCenter(useAppStore.getState(), 'attention')
  }
}

/** The person saves a finished session: applied now, recorded after. */
export function saveFinishedSession(session: SidebarSession, folderId: string | null): boolean {
  loadedFolders()
  const key = conversationViewKey(session)
  if (!applyPersonStoreChange(finishSaveChange(key, finishSaveDestination(folderId), BY_WORK))) {
    return false
  }
  leaveSavedSession(session)
  return true
}

/** A finished run saves its session: recorded before it runs. */
export async function saveFinishedSessionByApp(
  session: SidebarSession,
  folderId: string | null
): Promise<boolean> {
  loadedFolders()
  const key = conversationViewKey(session)
  const saved = await applyRecordedChange(
    finishSaveChange(key, finishSaveDestination(folderId), BY_FINISH)
  )
  if (!saved.ok) {
    return false
  }
  leaveSavedSession(session)
  return true
}

/**
 * Carry out what the HOST recorded for a finished run and report the result
 * (`session-finish-disposition.ts`). A `null` session is a source row this device no longer has.
 */
export function applySessionDisposition(
  session: SidebarSession | null,
  chain: SessionChain,
  now = Date.now()
): Promise<void> {
  return applyHostSessionDisposition(session, chain, now, saveFinishedSessionByApp)
}

/** Presentation follows the host's current verified outcome; it never executes a handoff. */
export function applySessionFinishAction(
  session: SidebarSession,
  expected: SessionFinishAction
): Promise<void> {
  return applyLegacySessionFinishAction(session, expected, {
    keep: keepFinishedSessionForMeByApp,
    save: saveFinishedSessionByApp
  })
}

/**
 * Whether a local run's source row is known to be gone rather than not loaded yet: only a restored
 * workspace can say so, and only for this device's own host.
 */
function sessionSourceIsGone(
  state: { workspaceSessionReady?: boolean },
  chain: SessionChain
): boolean {
  if (state.workspaceSessionReady !== true) {
    return false
  }
  try {
    return outcomeOwnerKey(chain) === 'local'
  } catch {
    return false
  }
}

export function adoptSessionFinishAction(session: SidebarSession, chain: SessionChain): void {
  const state = useSessionFolders.getState()
  if (!state.loaded) {
    state.load()
  }
  const key = conversationViewKey(session)
  const current = useSessionFolders.getState().metadata.finishActions?.[key]
  const host = hostSessionFinishChoice(session, chain, current)
  if (host && host !== current) {
    useSessionFolders.getState().setFinishAction(key, host)
  }
}

/**
 * One pass over what this window can see. The HOST record comes first — every sealed run,
 * whichever chain its row currently shows — and the device mirror is consulted only for chains a
 * host that predates the seal left without one.
 */
export function applyDueSessionFinishes(now = Date.now()): void {
  const state = useAppStore.getState()
  const sessions = buildSidebarSessions(state)
  const byRow = new Map(sessions.map((session) => [session.rowKey, session]))
  for (const { chain } of getAllSessionChainEntries()) {
    if (!chain.outcomeSet?.completion) {
      continue
    }
    const session = byRow.get(chain.sourceRowKey) ?? null
    if (session || sessionSourceIsGone(state, chain)) {
      void applySessionDisposition(session, chain, now)
    }
  }
  for (const session of sessions) {
    const preference =
      useSessionFolders.getState().metadata.finishActions?.[conversationViewKey(session)]
    if (preference?.afterCompletion) {
      void applyWhenFinished(session, preference, saveFinishedSessionByApp)
      continue
    }
    const chain = findShownSessionChainForRow(session.rowKey)
    if (!chain || chain.outcomeSet?.completion) {
      continue
    }
    adoptSessionFinishAction(session, chain)
    const action =
      useSessionFolders.getState().metadata.finishActions?.[conversationViewKey(session)]
    if (action && !action.applied) {
      void applySessionFinishAction(session, action)
    }
  }
}

export function useSessionFinishActions(): void {
  const loaded = useSessionFolders((state) => state.loaded)
  const load = useSessionFolders((state) => state.load)
  useEffect(() => {
    if (!loaded) {
      load()
    }
  }, [loaded, load])
  useEffect(() => {
    const tick = (): void => {
      if (!useSessionSidebarView.getState().loaded) {
        useSessionSidebarView.getState().load()
      }
      updateDoneArchiveClocks()
      updateUnreachableBlankClocksNow()
      applyDueSessionFinishes()
      void applyAutomaticSessionArchives()
    }
    tick()
    const unwatch = watchDoneArchiveClocks()
    const unsubscribe = subscribeSessionChains(tick)
    const timer = setInterval(tick, 5_000)
    return () => {
      unsubscribe()
      unwatch()
      clearInterval(timer)
    }
  }, [])
}
