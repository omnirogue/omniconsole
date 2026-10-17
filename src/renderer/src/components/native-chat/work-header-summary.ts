import {
  doneWhenCountLabel,
  doneWhenFacts,
  outcomeSentence
} from '@/components/next-action/done-when-facts'
import type { AgentBadgeState } from '@/components/next-action/session-details-facts'
import { describeSessionChainStrip } from '@/components/next-step/next-step-summary'
import { planNeedsYouCaption } from '@/components/sidebar/session-folders/session-plan-caption'
import { translate } from '@/i18n/i18n'
import { currentSessionRunRowState } from '@/lib/session-run-row-state'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { AgentStatusState, AgentWorkingMode } from '../../../../shared/agent-status-types'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { backgroundWorkLine } from '@/lib/background-work-wording'

/**
 * What the folded Work header can say from the push sources alone (chain registry, pane status,
 * Session details facts): no Up next poll runs while the composer is unmounted, so the strip
 * never reads `UpNextView`. Format: [outcome] · [proof] · [status], empty parts dropped.
 */
export type WorkHeaderStatusKind =
  | 'needs-you'
  | 'queued'
  | 'closed'
  | 'working'
  | 'background'
  | 'idle'

export type WorkHeaderSummary = {
  text: string
  kind: WorkHeaderStatusKind
}

export type WorkHeaderSummaryInput = {
  chain: SessionChain | null
  session: Pick<SidebarSession, 'paneKey'>
  /** `facts.agent.state` from `useSessionDetailsFacts`. */
  agentState: AgentBadgeState
  /** `agentStatusByPaneKey[paneKey]?.state`. */
  paneAgentState: AgentStatusState | null | undefined
  /** `agentStatusByPaneKey[paneKey]?.workingMode`: the turn ended and background work runs. */
  paneWorkingMode?: AgentWorkingMode
  paneBackgroundTaskCount?: number
  /** Where the conversation's current goal stands ("Checks · #1007 failing"), when it has PRs. */
  progress?: string | null
}

export function workHeaderQueuedCount(chain: SessionChain | null | undefined): number {
  return chain?.steps.filter((step) => step.status === 'queued').length ?? 0
}

/**
 * Why the chain asks for the person, or null. The outcome run's own open request comes first
 * (the host's sentence, e.g. "receipt never signed"); a plan parked on a pane prompt reads the
 * sidebar's caption for it. Never a raw block code.
 */
export function workHeaderNeedsYouReason(
  chain: SessionChain | null | undefined,
  session: Pick<SidebarSession, 'paneKey'>
): string | null {
  if (!chain) {
    return null
  }
  if (chain.outcomeSet) {
    const run = currentSessionRunRowState(chain)
    if (run.phase === 'needs-you') {
      return run.requests[0]?.ask?.trim() || run.headline
    }
  }
  if (chain.blocked) {
    return planNeedsYouCaption(chain.blocked, chain.blocked.paneKey === session.paneKey)
  }
  return null
}

/** The E1 key: a new value means a new ask; the same value republished is not news. */
export function workHeaderNeedsYouKey(
  chain: SessionChain | null | undefined,
  session: Pick<SidebarSession, 'paneKey'>,
  paneAgentState: AgentStatusState | null | undefined
): string {
  const reason = workHeaderNeedsYouReason(chain, session)
  const blocked = paneAgentState === 'blocked'
  return reason !== null || blocked ? `${chain?.id ?? ''}|${reason ?? ''}|${blocked}` : ''
}

/** Conversation information is opt-in; explicit saved choices still win. */
export function workHeaderDefaultCollapsed(): boolean {
  return true
}

function queuedStrip(chain: SessionChain): string {
  // Why slice(1): the strip opens with "Current", which is this very conversation.
  return translate('conversations.workQueued', 'then → {{steps}}', {
    steps: describeSessionChainStrip(chain).slice(1).join(' → ')
  })
}

function statusPart(input: WorkHeaderSummaryInput): WorkHeaderSummary {
  const { chain, agentState, paneAgentState } = input
  const reason = workHeaderNeedsYouReason(chain, input.session)
  if (reason !== null || paneAgentState === 'blocked') {
    const needsYou = translate('conversations.workNeedsYou', 'needs you')
    return { kind: 'needs-you', text: reason ? `${needsYou} · ${reason}` : needsYou }
  }
  if (chain && workHeaderQueuedCount(chain) > 0) {
    return { kind: 'queued', text: queuedStrip(chain) }
  }
  if (agentState === 'closed') {
    return { kind: 'closed', text: translate('conversations.workClosed', 'closed') }
  }
  // Why: the badge reads any `working` pane as running; a finished turn's background work is not.
  if (paneAgentState === 'working' && input.paneWorkingMode === 'monitoring') {
    // Why the row's wording: one phrase, one casing on every surface that shows this state.
    return { kind: 'background', text: backgroundWorkLine(input.paneBackgroundTaskCount) }
  }
  if (agentState === 'running' || paneAgentState === 'working') {
    return { kind: 'working', text: translate('conversations.workWorking', 'working') }
  }
  return { kind: 'idle', text: translate('conversations.workIdle', 'idle · waiting for you') }
}

export function workHeaderSummary(input: WorkHeaderSummaryInput): WorkHeaderSummary {
  // Why no placeholder: most conversations never set an outcome, so "No outcome yet" read as a
  // fault on every one of them. Without one, the current goal's milestone speaks, else nothing.
  const outcome = outcomeSentence(input.chain) ?? input.progress ?? null
  const facts = doneWhenFacts(input.chain)
  const proof = facts.total > 0 ? doneWhenCountLabel(facts) : null
  const status = statusPart(input)
  return {
    kind: status.kind,
    text: [outcome, proof, status.text].filter((part) => part !== null).join(' · ')
  }
}
