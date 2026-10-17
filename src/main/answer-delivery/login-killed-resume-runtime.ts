/**
 * The real dependencies behind the login-killed resume timer: the account login reading, this
 * runtime's rows and verdicts, `resumeConversation` (same conversation, same account), and the
 * prompt queue bound to the proven agent process. Also records the Codex failures no hook reports.
 */

import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import { normalizeLaunchCause } from '../../shared/launch-cause'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import { parseSessionReference, rowsForSessionReference } from '../../shared/session-reference'
import { runtimeReviewRowReader } from '../artifacts/artifact-review-wake-runtime'
import { readCodexRolloutTurnFailure } from '../runtime/codex-rollout-turn-failure'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { readPaneAgentPresence } from '../runtime/prompt-queue-agent-presence'
import { enqueueConversationPrompt } from '../runtime/prompt-queue-enqueue'
import { bindSessionPrompt } from '../runtime/session-prompt-binding'
import { resumeConversation } from '../session-manage/session-manage-resume'
import { runtimeResumeDeps } from '../session-manage/session-manage-resume-runtime'
import { SessionManageRefusal } from '../session-manage/session-manage-refusal'
import { resumeRefusalReason } from '../work-delivery/work-delivery-runtime'
import { accountLoginReady } from './account-login-ready'
import {
  LOGIN_RESUME_MAX_AGE_MS,
  LoginResumeRefusal,
  type LoginResumeDeps,
  type LoginResumeHolder,
  type LoginResumePane,
  type LoginResumeTurn
} from './login-killed-resume'
import { loginKilledTurnFromRollout, recordLoginKilledTurn } from './login-killed-turns'
import type { LoginKilledTurnStore } from './login-killed-turns-store'

const ACTOR = 'login-resume'

const sourceOf = (pane: LoginResumePane): ConversationSource => ({
  kind: 'pty',
  worktreeId: pane.worktreeId,
  paneKey: pane.paneKey
})

export function runtimeLoginResumeDeps(input: {
  runtime: OrcaRuntimeService
  userDataPath: string
  store: LoginKilledTurnStore
}): LoginResumeDeps {
  const { runtime, userDataPath } = input
  const { readRows, observe, windowAttached } = runtimeReviewRowReader(runtime)
  const liveRows = async (): Promise<SessionManageSidebarRow[]> =>
    (await readRows()).filter((row) => row.paneKey !== null)
  const hookOf = (pane: LoginResumePane) => {
    try {
      const { handle } = runtime.resolveTerminalPane(pane.paneKey, pane.worktreeId)
      return runtime.getFreshAgentHookStatusForHandle(handle)
    } catch {
      return null
    }
  }
  const paneOf = (row: SessionManageSidebarRow): LoginResumePane => ({
    paneKey: row.paneKey!,
    worktreeId: row.worktreeId
  })
  return {
    store: input.store,
    loginReady: (record) =>
      accountLoginReady(runtime, {
        provider: record.provider,
        home: record.home,
        since: record.killedAt
      }),
    windowAttached,
    findPane: async (record): Promise<LoginResumeHolder> => {
      const reference = parseSessionReference(record.ref)
      if (!reference) {
        return { kind: 'blocked', reason: `${record.ref} is not a session reference` }
      }
      const rows = await liveRows()
      const holders = rowsForSessionReference(reference, rows)
      // Why a reopened pane counts before it reports its conversation: this timer reopened it there.
      const reopened = record.target
        ? rows.find((row) => row.paneKey === record.target!.paneKey)
        : undefined
      const own = holders.find((row) => row.paneKey === record.paneKey)
      const ordered = [...new Set([reopened, own, ...holders].filter((row) => row !== undefined))]
      let blocked: string | null = null
      for (const row of ordered) {
        const entry = await observe(row)
        if (entry.verdict === 'live' && entry.state !== 'unknown') {
          return { kind: 'live', pane: paneOf(row) }
        }
        if (entry.verdict !== 'exited') {
          // Loss of contact is never evidence of an exit; a second copy is never started.
          blocked ??= `“${entry.title}” cannot be verified, so it is not reopened`
        }
      }
      return blocked ? { kind: 'blocked', reason: blocked } : { kind: 'none' }
    },
    turn: (pane): LoginResumeTurn | null => {
      const hook = hookOf(pane)
      return hook
        ? { state: hook.state, startedAt: hook.stateStartedAt, boundary: !!hook.sessionBoundary }
        : null
    },
    resume: async (record): Promise<LoginResumePane> => {
      let resumed: Awaited<ReturnType<typeof resumeConversation>>
      try {
        resumed = await resumeConversation(
          runtimeResumeDeps(runtime, {
            userDataPath,
            launchCause: normalizeLaunchCause({
              trigger: 'hibernation-wake',
              actor: { kind: 'app' }
            }),
            ...(record.model ? { launchPreferences: { model: record.model } } : {})
          }),
          { actor: { kind: 'steward', feature: 'rules' }, ref: record.ref, dryRun: false }
        )
      } catch (error) {
        if (error instanceof SessionManageRefusal) {
          const reason = resumeRefusalReason(error.message)
          throw new LoginResumeRefusal(
            reason === 'protection' || reason === 'transcript_gone' ? reason : 'unverifiable',
            error.message
          )
        }
        throw error
      }
      const paneKey = 'paneKey' in resumed ? (resumed.paneKey ?? null) : null
      if (!paneKey) {
        throw new Error('It was reopened, but its pane cannot be named.')
      }
      const row = (await liveRows()).find((candidate) => candidate.paneKey === paneKey)
      return { paneKey, worktreeId: row?.worktreeId ?? record.worktreeId }
    },
    enqueue: async (pane, id, text) => {
      const source = sourceOf(pane)
      const presence = await readPaneAgentPresence(runtime, source)
      if (presence.kind !== 'proven') {
        return false
      }
      bindSessionPrompt(conversationSourceRowKey(source), id, { receiver: presence.proof })
      enqueueConversationPrompt(runtime, source, {
        id,
        text,
        requestedBy: { action: 'continue', actor: ACTOR }
      })
      return true
    },
    queueState: (pane, id) => {
      const entry = runtime
        .readPromptQueue(conversationSourceRowKey(sourceOf(pane)))
        ?.entries.find((candidate) => candidate.id === id)
      if (!entry) {
        return 'missing'
      }
      if (entry.state === 'failed') {
        return entry.unsent ? 'failed-unsent' : 'failed'
      }
      return entry.state
    },
    // Why a scan: Codex fires no hook on a failed turn, so its rollout is the only trace.
    scan: async () => {
      const now = Date.now()
      for (const row of await liveRows()) {
        if (row.kind !== 'terminal' || row.hostUnavailable) {
          continue
        }
        const pane = paneOf(row)
        const transcript = runtime.getSessionOutcomeTranscriptSource({
          sourcePaneKey: pane.paneKey,
          worktreeId: pane.worktreeId
        })
        if (transcript?.kind !== 'provider' || transcript.agent !== 'codex') {
          continue
        }
        const transcriptPath = transcript.transcriptPath
        const failure = transcriptPath ? readCodexRolloutTurnFailure(transcriptPath) : null
        if (!transcriptPath || !failure || now - failure.failedAt > LOGIN_RESUME_MAX_AGE_MS) {
          continue
        }
        const hook = hookOf(pane)
        recordLoginKilledTurn(
          loginKilledTurnFromRollout(
            { ...pane, sessionId: transcript.sessionId, transcriptPath },
            failure,
            hook
              ? { stateStartedAt: hook.stateStartedAt, interactive: !!hook.interactivePrompt }
              : null
          )
        )
      }
    },
    now: () => Date.now()
  }
}
