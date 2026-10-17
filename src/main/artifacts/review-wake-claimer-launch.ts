/**
 * The claiming computer's launch and delivery for a moved session: the same resume `omni session
 * resume` uses, with the recorded model and effort, confirmed only by the agent's own report; then
 * the decision, bound to that proven process like Phase 1's deliveries.
 */

import { randomUUID } from 'node:crypto'
import { artifactDecisionMessage } from '../../shared/artifact-review-decision-message'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import { normalizeLaunchCause } from '../../shared/launch-cause'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { readPaneAgentPresence } from '../runtime/prompt-queue-agent-presence'
import { enqueueConversationPrompt } from '../runtime/prompt-queue-enqueue'
import { prepareSessionTarget } from '../runtime/rpc/methods/session-manage-support'
import { bindSessionPrompt } from '../runtime/session-prompt-binding'
import { SessionResumeWorkspaceMissing } from '../session-manage/session-manage-resume'
import { runtimeResumeDeps } from '../session-manage/session-manage-resume-runtime'
import type { StagedRelocation } from '../session-relocation/relocation-bundle-import'
import { ClaimerStepError, type MoveFacts, type WakeCandidate } from './review-wake-claimer'
import type { WakeCopyHeader } from './review-wake-copy-pack'

const PRESENCE_TRIES = 60
// Why these only: they are refused before any terminal exists; any other launch error may follow one.
const BEFORE_SPAWN = new Set([
  'selector_not_found',
  'selector_ambiguous',
  'agent_session_legacy_required',
  'agent_session_identity_required',
  'runtime_unavailable'
])

export async function launchMovedConversation(
  runtime: OrcaRuntimeService,
  userDataPath: string,
  staged: StagedRelocation,
  workspacePath: string,
  header: WakeCopyHeader
): Promise<{ paneKey: string }> {
  const resume = runtimeResumeDeps(runtime, {
    userDataPath,
    launchCause: normalizeLaunchCause({ trigger: 'hibernation-wake', actor: { kind: 'app' } }),
    ...(header.model || header.effort
      ? {
          launchPreferences: {
            ...(header.model ? { model: header.model } : {}),
            ...(header.effort ? { effort: header.effort } : {})
          }
        }
      : {})
  })
  const reference = { agent: staged.identity.agent, sessionId: header.sessionId, hostId: 'local' }
  const launched = await resume
    .launch({
      reference,
      transcriptPath: staged.identity.transcriptPath,
      cwd: workspacePath,
      providerRoot: staged.identity.providerRoot
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof SessionResumeWorkspaceMissing || BEFORE_SPAWN.has(message)) {
        throw new ClaimerStepError(message, 'could not start')
      }
      // Anything else may follow a spawn, so the claim is kept and confirmed done.
      throw error
    })
  const verdict = await resume.confirm(reference, launched)
  if (verdict.state !== 'same' || !verdict.paneKey) {
    throw new Error('the started agent did not report the same conversation')
  }
  return { paneKey: verdict.paneKey }
}

export async function deliverMovedDecision(
  runtime: OrcaRuntimeService,
  origin: string | null,
  paneKey: string,
  item: WakeCandidate,
  sessionId: string,
  moved: MoveFacts
): Promise<void> {
  const prepared = await prepareSessionTarget(runtime, { paneKey })
  const text = artifactDecisionMessage({
    slug: item.slug,
    title: item.title,
    shareUrl: item.shareUrl ?? (origin ? `${origin}/a/${item.slug}` : item.slug),
    decision: item.decision,
    woke: true,
    moved
  })
  const source = { kind: 'pty' as const, worktreeId: prepared.row.worktreeId, paneKey }
  let presence = await readPaneAgentPresence(runtime, source)
  for (let tries = 0; presence.kind !== 'proven' && tries < PRESENCE_TRIES; tries += 1) {
    await new Promise((done) => setTimeout(done, 1_000))
    presence = await readPaneAgentPresence(runtime, source)
  }
  if (presence.kind !== 'proven') {
    throw new Error('the woken agent could not be proven in its pane')
  }
  const id = randomUUID()
  // Why bound like Phase 1: the queue sends a relayed prompt only to the process it checked.
  const still = () => runtime.getReportedProviderSessionsForPane(paneKey)[0]?.id === sessionId
  bindSessionPrompt(conversationSourceRowKey(source), id, {
    receiver: presence.proof,
    conversationStill: still,
    conversationGuard: async () => (still() ? null : 'The woken conversation changed.')
  })
  enqueueConversationPrompt(runtime, source, {
    id,
    text,
    requestedBy: { action: 'continue', actor: 'artifact-review' }
  })
}
