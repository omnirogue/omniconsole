/**
 * Keeps the account registry in step with this host's sessions. Every local session with a
 * provider identity is registered, so other computers can see it; only one with verified evidence
 * is adopted (control and automatic writers then pass admission): live on this runtime, its agent
 * proven to hold the terminal (or its chat held here), and a readable turn revision. A session
 * whose turn this host cannot read stays unadopted, so its own queued prompts flow as before.
 */

import { sameConversationSource } from '../../shared/conversation-source'
import type { SessionHostProviderIdentity } from '../../shared/session-host-identity'
import type { SessionHostAdmissionStore } from '../session-host/session-host-admission-store'
import type {
  SessionHostJournal,
  SessionHostRegistration,
  SessionHostWorkspace
} from '../session-host/session-host-journal'
import { registerSessionHostConversation } from '../session-host/session-host-ownership-registry'
import type { HostSession } from './host-session-inventory'
import { relocatedAwayIn } from './session-host-relocated-journal'

export type HostSessionAdoptionResult = {
  registered: number
  adopted: number
  refused: { paneKey: string | null; reason: string }[]
}

export function hostSessionProvider(session: HostSession): SessionHostProviderIdentity | null {
  const { row } = session
  const sessionId = row.providerSessionId?.trim()
  return sessionId && row.agent ? { agent: row.agent, sessionId } : null
}

export function hostSessionWorkspace(session: HostSession): SessionHostWorkspace | null {
  const { row } = session
  return row.worktreePath && row.workspaceKind !== 'unknown'
    ? { kind: row.workspaceKind, path: row.worktreePath }
    : null
}

function processIncarnation(session: HostSession): string | null {
  const proof = session.agentProcess
  if (proof) {
    return `pid:${proof.pid}:${proof.startTimeMs}`
  }
  return session.source?.kind === 'structured' && session.source.sessionId
    ? `chat:${session.source.sessionId}`
    : null
}

/** Verified evidence that this runtime runs it now; the turn gate is the caller's reading. */
export function hostSessionAdoptable(session: HostSession, turnRevision: string | null): boolean {
  const { entry, source } = session
  if (!source || entry.verdict !== 'live' || turnRevision === null) {
    return false
  }
  return source.kind === 'structured' || (entry.agentForeground === true && !!session.agentProcess)
}

function registrationsOf(
  journal: SessionHostJournal,
  provider: SessionHostProviderIdentity
): SessionHostRegistration[] {
  return Object.values(journal.conversations).filter(
    (registration) =>
      registration.provider.agent === provider.agent &&
      registration.provider.sessionId === provider.sessionId
  )
}

function unchanged(
  existing: SessionHostRegistration,
  session: HostSession,
  wantAdopted: boolean,
  controller: string
): boolean {
  const workspace = hostSessionWorkspace(session)
  return (
    existing.controller === controller &&
    (existing.adopted || !wantAdopted) &&
    existing.processIncarnation === processIncarnation(session) &&
    existing.binding !== null &&
    session.source !== null &&
    sameConversationSource(existing.binding, session.source) &&
    existing.workspace?.kind === workspace?.kind &&
    existing.workspace?.path === workspace?.path
  )
}

function preferred(a: HostSession, b: HostSession): boolean {
  const liveA = a.entry.verdict === 'live'
  if (liveA !== (b.entry.verdict === 'live')) {
    return liveA
  }
  return (a.entry.lastActivityAt ?? 0) > (b.entry.lastActivityAt ?? 0)
}

type Candidate = { session: HostSession; provider: SessionHostProviderIdentity }

/** One session per provider identity: the live one, else the most recently active. */
function bestPerProvider(sessions: readonly HostSession[]): Candidate[] {
  const best = new Map<string, Candidate>()
  for (const session of sessions) {
    const provider = hostSessionProvider(session)
    if (!provider || !session.source) {
      continue
    }
    const key = JSON.stringify([provider.agent, provider.sessionId])
    const held = best.get(key)
    if (!held || preferred(session, held.session)) {
      best.set(key, { session, provider })
    }
  }
  return [...best.values()]
}

export async function adoptHostSessions(input: {
  store: SessionHostAdmissionStore
  sessions: readonly HostSession[]
  turnRevision: (session: HostSession) => string | null
}): Promise<HostSessionAdoptionResult> {
  const result: HostSessionAdoptionResult = { registered: 0, adopted: 0, refused: [] }
  const journal = input.store.snapshot()
  if (!journal) {
    return result
  }
  const controller = input.store.host.incarnation
  for (const { session, provider } of bestPerProvider(input.sessions)) {
    // Why skip: relocated away, it is another host's now; this row is only its old pane.
    if (relocatedAwayIn(journal, provider)) {
      continue
    }
    const existing = registrationsOf(journal, provider).find((registration) => registration.owned)
    const wantAdopted = hostSessionAdoptable(session, input.turnRevision(session))
    // Why no write: an unchanged registration would rewrite the account's journal every pass.
    if (existing && unchanged(existing, session, wantAdopted, controller)) {
      continue
    }
    const registered = await registerSessionHostConversation(input.store, {
      provider,
      binding: session.source,
      workspace: hostSessionWorkspace(session),
      processIncarnation: processIncarnation(session),
      adopted: wantAdopted
    }).catch((error: unknown) => ({
      status: 'refused' as const,
      refusal: { message: error instanceof Error ? error.message : String(error) }
    }))
    if (registered.status === 'refused') {
      result.refused.push({ paneKey: session.entry.paneKey, reason: registered.refusal.message })
      continue
    }
    result.registered += 1
    if (registered.registration.adopted) {
      result.adopted += 1
    }
  }
  return result
}
