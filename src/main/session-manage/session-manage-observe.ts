/**
 * One sidebar row, observed on this host: its execution verdict, what its agent is doing, its
 * queue, its own open steps and its Keep going. `exited` needs positive evidence from the
 * execution host; an SSH or paired host that cannot be read is
 * `unverifiable`, and a row whose pane this runtime cannot place is never assumed dead. A local
 * terminal's state does not wait for its agent's next hook: after a restart the host reads its
 * last report, the foreground process and the screen (`session-manage-pty-activity.ts`).
 */

import { classifyAgentTurnFailure } from '../../shared/agent-turn-failure'
import {
  structuredConversationSource,
  type ConversationSource
} from '../../shared/conversation-source'
import { parseExecutionHostId } from '../../shared/execution-host'
import { promptQueuePending, type PromptQueue } from '../../shared/prompt-queue-types'
import type { SessionExecutionVerdict, SessionStateBasis } from '../../shared/session-manage-types'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { TerminalAgentEvidence } from '../runtime/terminal-agent-evidence'
import type { TerminalAgentProcessProof } from '../runtime/terminal-agent-process'
import type { SessionHookReading } from './session-manage-hook-activity'
import { derivePtyActivity, type SessionLastHookReading } from './session-manage-pty-activity'
import type { SessionAgentActivity, SessionStateFacts } from './session-manage-state'
import { providerLimit } from './session-manage-provider-limit'
import type { SessionPrompt } from './session-prompt'
import type { SessionManageWorkflowAnchor } from '../../shared/session-workflow-anchor'
import { observeWorkflowRow, type SessionWorkflowRunReader } from './session-manage-workflow'

export type SessionChatReading = {
  status: 'working' | 'attention' | 'idle' | null
  failed?: boolean
  failureReason?: string
  updatedAt: number
}

/** What this host can read, narrowed so a test can stand in for the runtime. */
export type SessionObserveSources = {
  resolvePane(
    paneKey: string,
    worktreeId: string
  ): { handle: string; connected: boolean; ptyId: string | null } | null
  /** The runtime's own "could not verify" reason for this terminal, when it has one. */
  livenessUnverifiable(handle: string): string | null
  /** True while an agent holds the terminal; false at a shell; `gone` once the PTY is. */
  agentStatus(
    handle: string
  ): Promise<{ running: boolean; status: 'working' | 'permission' | 'idle' | null } | 'gone'>
  hook(handle: string): SessionHookReading | null
  /** What its terminal title alone shows now (never a hook report). */
  titleStatus(handle: string): 'working' | 'permission' | 'idle' | null
  /** A receipt that this local terminal's process exited (its provider's own wait status). */
  exitReceipt(handle: string): boolean
  /** The newest hook report this host holds for the pane, however old. */
  lastHook(paneKey: string): SessionLastHookReading | null
  /** The pane's foreground process and screen; null when neither could be read. */
  evidence(handle: string, expectedAgent: string): Promise<TerminalAgentEvidence | null>
  /** Null when no chat host runs on this computer. */
  chat(sessionId: string): { held: boolean; reading: SessionChatReading | null } | null
  queue(source: ConversationSource): PromptQueue | null
  ownSteps(source: ConversationSource): Promise<string[]>
  keepGoing(source: ConversationSource): boolean
  /** What the conversation's live outcome plan still waits on; absent where no plan is read. */
  planWaits?(source: ConversationSource): readonly string[]
  prompt?(row: SessionManageSidebarRow, terminal: string | null): Promise<SessionPrompt | null>
  /** A workflow run read from the controller that owns it; absent, the window's last reading. */
  workflowRun?: SessionWorkflowRunReader
}

export type ObservedSession = {
  row: SessionManageSidebarRow
  source: ConversationSource | null
  terminal: string | null
  facts: SessionStateFacts
  /** What the state rests on. */
  stateBasis: SessionStateBasis
  /** The agent provably holds its terminal; null for a chat or when it could not be read. */
  agentForeground: boolean | null
  /** The pid proof behind `agentForeground: true`; a queued prompt is bound to it. */
  agentProcess: TerminalAgentProcessProof | null
  lastActivityAt: number | null
  keepGoing: boolean
  prompt?: SessionPrompt
  /** A workflow conversation's run, with the state just observed. */
  workflow?: SessionManageWorkflowAnchor
}

type Verdict = {
  verdict: SessionExecutionVerdict
  reason?: string
  handle?: string
  activity?: SessionAgentActivity
  basis?: SessionStateBasis
  agentForeground?: boolean | null
}

type PtyVerdict = Verdict & { lastActivityAt?: number; agentProcess?: TerminalAgentProcessProof }

const liveUnknown = (handle: string, reason: string): Verdict => ({
  verdict: 'live',
  handle,
  activity: { kind: 'unknown', reason },
  agentForeground: false
})

const unverifiable = (reason: string, handle?: string): Verdict => ({
  verdict: 'unverifiable',
  reason,
  ...(handle ? { handle } : {})
})

export function sessionManageSource(row: SessionManageSidebarRow): ConversationSource | null {
  if (row.kind === 'structured') {
    return row.structuredSessionId
      ? structuredConversationSource(row.worktreeId, row.structuredSessionId)
      : null
  }
  return row.paneKey ? { worktreeId: row.worktreeId, paneKey: row.paneKey, kind: 'pty' } : null
}

const OWNERSHIP_UNVERIFIED_REASON = {
  'conflicting-provenance':
    'Its owning computer cannot be verified: its saved details name more than one computer, so it is kept here and not shared.',
  'unresolved-workspace':
    'Its owning computer cannot be verified: its workspace is recorded on more than one computer.',
  'absence-unverified':
    'Its computer stopped listing it without confirming it closed, so it is kept here until that computer can check.'
} as const

function hostVerdict(row: SessionManageSidebarRow): Verdict | 'local' | 'ssh' {
  if (row.ownershipUnverified) {
    // Why: a quarantined row stays listed; nothing about it may be read as one computer's state.
    return unverifiable(OWNERSHIP_UNVERIFIED_REASON[row.ownershipUnverified])
  }
  const host = parseExecutionHostId(row.hostId)
  if (!host) {
    return unverifiable('This computer does not know which host runs its workspace.')
  }
  if (host.kind === 'runtime') {
    return unverifiable('It runs on another OmniConsole; Stage A manages this computer only.')
  }
  if (row.hostUnavailable) {
    return unverifiable('Its host is not connected, so its state cannot be verified.')
  }
  return host.kind
}

/** Whether the agent holding the terminal is this row's: a recognized agent must match its kind. */
function agentMatchesRow(proof: TerminalAgentProcessProof, row: SessionManageSidebarRow): boolean {
  return proof.agent === null || !isTuiAgent(row.agent) || proof.agent === row.agent
}

async function observePty(
  row: SessionManageSidebarRow,
  hostKind: 'local' | 'ssh',
  sources: SessionObserveSources
): Promise<PtyVerdict> {
  const local = hostKind === 'local'
  if (!row.paneKey) {
    return unverifiable('It has no pane yet; it may still be starting.')
  }
  const pane = sources.resolvePane(row.paneKey, row.worktreeId)
  if (!pane) {
    return local && !row.tabId
      ? { verdict: 'exited', reason: 'Its tab is closed; the conversation history is kept.' }
      : unverifiable('No terminal on this computer is attached to its pane right now.')
  }
  const livenessReason = sources.livenessUnverifiable(pane.handle)
  if (livenessReason) {
    return unverifiable(livenessReason, pane.handle)
  }
  // Why a receipt: a detached or restoring terminal is not an ended one.
  const notAttached = (): Verdict =>
    local && !row.launchPending && sources.exitReceipt(pane.handle)
      ? { verdict: 'exited', reason: 'Its terminal process ended.', basis: 'process' }
      : unverifiable(
          local
            ? 'Its terminal is not attached on this computer right now; it may be restoring.'
            : 'Its SSH host did not confirm the terminal is running.',
          pane.handle
        )
  if (!pane.connected || !pane.ptyId) {
    return notAttached()
  }
  let status: Awaited<ReturnType<SessionObserveSources['agentStatus']>>
  try {
    status = await sources.agentStatus(pane.handle)
  } catch {
    return unverifiable('Its terminal could not be read.', pane.handle)
  }
  if (status === 'gone') {
    return notAttached()
  }
  const lastHook = sources.lastHook(row.paneKey)
  const evidence = await sources.evidence(pane.handle, row.agent)
  const foreground = evidence?.foreground ?? { kind: 'unavailable' as const }
  const tree = evidence?.tree ?? null
  // Why a fresh process table and nothing cached: a stopped job or a stale shell flag is no exit.
  if (!row.launchPending && tree?.kind === 'agent-gone') {
    return {
      verdict: 'exited',
      reason: 'Its agent exited; the terminal is back at the shell.',
      handle: pane.handle,
      basis: 'process',
      agentForeground: false
    }
  }
  if (tree?.kind === 'stopped' || (!status.running && !tree)) {
    return tree
      ? liveUnknown(
          pane.handle,
          'A job in its terminal is suspended (stopped): neither idle nor exited.'
        )
      : unverifiable(
          'Its terminal is live, but this computer could not read its processes to tell whether its agent is still there.',
          pane.handle
        )
  }
  const proof = evidence?.process ?? null
  const agentForeground = proof
    ? agentMatchesRow(proof, row)
    : foreground.kind === 'agent' || foreground.kind === 'unavailable'
      ? null
      : false
  // Why its own pid: only the agent process holding the terminal now speaks for it (working, or
  // waiting on the person; never idle, see `session-manage-pty-activity.ts`). A report naming no pid,
  // or received before that process started, never counts.
  const current = (reading: SessionHookReading): boolean =>
    proof !== null &&
    agentForeground === true &&
    reading.agentPid === proof.pid &&
    reading.updatedAt >= proof.startTimeMs
  const hook = sources.hook(pane.handle)
  const { activity, basis } = derivePtyActivity({
    status,
    title: sources.titleStatus(pane.handle),
    hook: hook && current(hook) ? hook : null,
    lastHook,
    screen: evidence?.screen ?? null,
    foregroundAgent: proof?.agent ?? (foreground.kind === 'agent' ? foreground.agent : null),
    agentInForeground: agentForeground === true || foreground.kind === 'agent'
  })
  const lastActivityAt = hook?.updatedAt ?? lastHook?.updatedAt
  return {
    verdict: 'live',
    handle: pane.handle,
    activity,
    basis,
    agentForeground,
    ...(agentForeground === true && proof ? { agentProcess: proof } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {})
  }
}

function observeChat(
  row: SessionManageSidebarRow,
  sources: SessionObserveSources
): Verdict & { updatedAt?: number } {
  const chat = row.structuredSessionId ? sources.chat(row.structuredSessionId) : null
  if (!chat) {
    return unverifiable('The chat host on this computer is not running.')
  }
  if (!chat.reading || (chat.reading.status === null && !chat.reading.failed)) {
    return unverifiable('The chat host has not restored this conversation yet.')
  }
  const reading = chat.reading
  const activity: SessionAgentActivity =
    reading?.status === 'working'
      ? { kind: 'working' }
      : reading?.status === 'attention'
        ? { kind: 'question' }
        : reading?.failed
          ? {
              kind: 'idle',
              failure: reading.failureReason ?? 'The provider gave no reason.',
              usageLimited: classifyAgentTurnFailure(reading.failureReason) === 'usage-limit'
            }
          : { kind: 'idle' }
  return {
    verdict: 'live',
    activity,
    basis: 'chat-host',
    ...(reading ? { updatedAt: reading.updatedAt } : {})
  }
}

export async function observeSession(
  row: SessionManageSidebarRow,
  sources: SessionObserveSources
): Promise<ObservedSession> {
  const source = sessionManageSource(row)
  // Why before the host and pane: a workflow's state is its controller's record of the run, and
  // that controller is this computer even when the workspace's host is not (C6).
  const workflow = await observeWorkflowRow(row, sources.workflowRun)
  const host = workflow ?? hostVerdict(row)
  let verdict: PtyVerdict
  let lastActivityAt: number | null = null
  if (typeof host !== 'string') {
    verdict = host
  } else if (row.kind === 'structured') {
    const chat = observeChat(row, sources)
    verdict = chat
    lastActivityAt = chat.updatedAt ?? null
  } else {
    const pty = await observePty(row, host, sources)
    verdict = pty
    lastActivityAt = pty.lastActivityAt ?? null
  }
  const live = verdict.verdict === 'live' && source !== null
  const queue = live ? sources.queue(source) : null
  const facts: SessionStateFacts = {
    verdict: verdict.verdict,
    ...(verdict.reason ? { verdictReason: verdict.reason } : {}),
    activity: verdict.activity ?? { kind: 'unknown' },
    queueLength: queue ? promptQueuePending(queue).length : 0,
    pendingSteps: live ? await sources.ownSteps(source) : [],
    ...(row.launchPending && !workflow ? { launchPending: true } : {})
  }
  const planWaits = live ? (sources.planWaits?.(source) ?? []) : []
  if (planWaits.length > 0) {
    facts.planWaits = planWaits
  }
  const limit = providerLimit(queue)
  if (limit) {
    facts.providerLimit = limit
  }
  // A contradictory hook must not hide a menu that is still on screen.
  const prompt = live ? await sources.prompt?.(row, verdict.handle ?? null) : null
  return {
    row,
    source,
    terminal: verdict.handle ?? null,
    facts,
    stateBasis: verdict.basis ?? 'none',
    agentForeground: verdict.agentForeground ?? null,
    agentProcess: verdict.agentProcess ?? null,
    lastActivityAt,
    keepGoing: source ? sources.keepGoing(source) : false,
    ...(prompt ? { prompt } : {}),
    ...(workflow ? { workflow: workflow.anchor } : {})
  }
}
