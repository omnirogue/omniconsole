/**
 * Whether a person has asked a local session anything, from this computer's own evidence: the
 * agent's latest hook report, its untouched fresh start (`fresh-pane-evidence.ts`) and, for
 * Claude and Codex, a positive read of its transcript (every line parsed, every user turn seen).
 * An unreadable, damaged or oversized transcript is `unknown`, never cleaned up. A missing one
 * (Claude writes it on the first prompt) reads `untouched` only on the fresh-start evidence.
 * Other agents (Gemini, OpenCode) have no transcript read here, so the fresh start alone speaks.
 * Evidence carried over an app restart also needs the same agent process, born before its start,
 * still holding the terminal, and an agent whose hooks spool while the app is down.
 */

import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import { isSessionManageMarkedPrompt } from '../../shared/session-manage-types'
import {
  FreshPaneEvidence,
  type FreshPaneReading,
  type FreshPaneStart
} from '../agent-hooks/fresh-pane-evidence'
import { FreshPaneEvidenceStore } from '../agent-hooks/fresh-pane-evidence-store'
import { agentHookServer } from '../agent-hooks/server'
import type { AiVaultFirstUserPromptProof } from '../ai-vault/session-first-user-prompt-proof'
import { proveAiVaultFirstUserPromptInBackground } from '../ai-vault/session-scanner-background'
import { onConversationWriteInvalidation } from '../runtime/conversation-write-fence'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { ObservedSession } from '../session-manage/session-manage-observe'
import { stewardPromptedReading, type StewardPromptedReading } from './steward-empty-session'

export type StewardHookRow = Pick<
  AgentStatusIpcPayload,
  'prompt' | 'providerSession' | 'receivedAt' | 'agentPid' | 'sessionBoundary'
>

export type StewardPromptedSources = {
  hook: (paneKey: string) => StewardHookRow | null
  prove: (args: {
    agent: 'claude' | 'codex'
    filePath: string
    sessionId?: string
  }) => Promise<AiVaultFirstUserPromptProof>
  fresh?: (paneKey: string, providerSessionId: string | null) => FreshPaneReading
  freshStart?: (paneKey: string) => FreshPaneStart | null
  /** An automated send left text in its input box (`terminal-unresolved-draft.ts`). */
  unresolvedDraft?: (terminal: string) => boolean
  /** The launch identity this app run minted for the pane's PTY (not an adopted one); SSH only. */
  launchToken?: (paneKey: string) => string | null
}

/** Agents whose hooks spool while the app is down, so a restart cannot hide an event. */
const RESTART_SAFE_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'gemini'])
/** Process start times are read to the second; a hook report lands just after its start. */
const START_SKEW_MS = 5_000

type ObservedProcess = Pick<ObservedSession, 'agentForeground' | 'agentProcess'>

/**
 * A record carried over a restart vouches only for the agent process it saw start: that pid,
 * born no later than the start, still holding the terminal, with the hook row still its start.
 */
function restartContinuity(
  start: FreshPaneStart,
  row: SessionManageSidebarRow,
  hook: StewardHookRow,
  observed: ObservedProcess | undefined
): boolean {
  const proof = observed?.agentProcess
  return (
    RESTART_SAFE_AGENTS.has(start.agent ?? '') &&
    (!start.legacy || start.agent === 'claude' || start.agent === 'codex') &&
    start.agent === row.agent &&
    hook.sessionBoundary === true &&
    hook.receivedAt <= start.startedAt + START_SKEW_MS &&
    observed?.agentForeground === true &&
    !!proof &&
    start.agentPid !== null &&
    proof.pid === start.agentPid &&
    proof.startTimeMs <= start.startedAt + START_SKEW_MS
  )
}

function freshReading(
  sources: StewardPromptedSources,
  row: SessionManageSidebarRow & { paneKey: string },
  hook: StewardHookRow,
  observed: ObservedProcess | undefined,
  sshTarget: string | null
): FreshPaneReading {
  const reading = sources.fresh?.(row.paneKey, hook.providerSession?.id ?? null) ?? 'unknown'
  if (reading !== 'untouched') {
    return reading
  }
  const start = sources.freshStart?.(row.paneKey)
  if (
    !start ||
    (start.agent !== null && row.agent !== start.agent) ||
    start.connectionId !== sshTarget
  ) {
    return 'unknown'
  }
  if (sshTarget !== null) {
    // Why: a kill cannot be undone, so only an agent this controller launched through the relay.
    const minted = start.launchToken ? sources.launchToken?.(row.paneKey) : null
    return minted && minted === start.launchToken ? 'untouched' : 'unknown'
  }
  if (start.restored) {
    return restartContinuity(start, row, hook, observed) ? 'untouched' : 'unknown'
  }
  // Why: a pane that now holds another agent process is not the one seen starting.
  const proof = observed?.agentProcess
  return start.agentPid !== null && proof && proof.pid !== start.agentPid ? 'unknown' : 'untouched'
}

export function stewardPersonPrompted(
  sources: StewardPromptedSources
): (row: SessionManageSidebarRow, observed?: ObservedSession) => Promise<StewardPromptedReading> {
  return async (row, observed) => {
    const host = parseExecutionHostId(row.hostId)
    // Why connected only: an SSH pane speaks here only while its relay forwards every event.
    const sshTarget = host?.kind === 'ssh' && !row.hostUnavailable ? host.targetId : null
    const paneKey = row.paneKey
    const hook = paneKey && (host?.kind === 'local' || sshTarget) ? sources.hook(paneKey) : null
    if (!hook || !paneKey) {
      return 'unknown'
    }
    const latest = hook.prompt?.trim() ?? ''
    if (latest && !isSessionManageMarkedPrompt(latest)) {
      return 'person'
    }
    // Why live only: a send still being typed into a running agent is its brief, not a blank.
    const live = observed?.facts.verdict === 'live'
    if (live && observed.terminal && (sources.unresolvedDraft?.(observed.terminal) ?? false)) {
      return 'unknown'
    }
    const fresh = freshReading(sources, { ...row, paneKey }, hook, observed, sshTarget)
    const session = hook.providerSession
    const agent = row.agent === 'claude' || row.agent === 'codex' ? row.agent : null
    // Why no transcript read on SSH: it lives on the host; the relay's hook events stand in.
    if (!agent || sshTarget) {
      if (sshTarget && !live) {
        return 'unknown'
      }
      return latest ? 'marked' : fresh === 'untouched' ? 'untouched' : 'unknown'
    }
    if (!session?.transcriptPath) {
      return 'unknown'
    }
    const proof = await sources
      .prove({ agent, filePath: session.transcriptPath, sessionId: session.id })
      .catch(() => null)
    if (!proof?.read) {
      return proof?.why === 'missing' && !latest && fresh === 'untouched' ? 'untouched' : 'unknown'
    }
    const reading = stewardPromptedReading({
      prompts: [latest, ...proof.prompts],
      complete: proof.complete
    })
    if (reading !== 'none') {
      return reading
    }
    // Why: typed input or a hook event since its start is what a transcript cannot show.
    return fresh === 'untouched' ? 'untouched' : fresh === 'touched' ? 'unknown' : 'none'
  }
}

/** Evidence of panes nobody has touched since their agent started fresh, kept across restarts. */
export function startFreshPaneEvidence(
  now: () => number,
  storePath: string | null
): FreshPaneEvidence {
  const tap = agentHookServer.hookEvents
  return new FreshPaneEvidence({
    subscribeHookEvents: (listener) => tap.subscribe(listener),
    subscribeWrites: onConversationWriteInvalidation,
    subscribeLost: (listener) => tap.subscribeLost(listener),
    continuityEpoch: () => tap.continuityEpoch(),
    spooledSince: (paneKey, sinceMs) => agentHookServer.hookSpoolWrittenSince(paneKey, sinceMs),
    drainedSince: (paneKey, sinceMs) => tap.drainedSince(paneKey, sinceMs),
    connectionEpoch: (connectionId) => tap.connectionEpoch(connectionId),
    ...(storePath
      ? {
          store: new FreshPaneEvidenceStore(storePath, now),
          hydratedRows: () => agentHookServer.getStatusSnapshot()
        }
      : {}),
    now
  })
}

export function runtimePersonPrompted(
  runtime: OrcaRuntimeService,
  fresh?: FreshPaneEvidence
): (row: SessionManageSidebarRow, observed?: ObservedSession) => Promise<StewardPromptedReading> {
  return stewardPersonPrompted({
    hook: (paneKey) => runtime.getLastAgentHookRowForPane(paneKey),
    prove: (args) => proveAiVaultFirstUserPromptInBackground({ ...args, executionHostId: 'local' }),
    unresolvedDraft: (terminal) => runtime.hasTerminalUnresolvedDraft(terminal),
    launchToken: (paneKey) => runtime.getAgentLaunchTokenForPane(paneKey),
    ...(fresh
      ? {
          fresh: (paneKey, id) => fresh.read(paneKey, id),
          freshStart: (paneKey) => fresh.start(paneKey)
        }
      : {})
  })
}
