import type { ArtifactWriteRequest } from '../../shared/artifacts'
import {
  getEffectiveReviewWaitLiveMinutes,
  type ArtifactReviewSleep,
  type ArtifactSessionSleepNotice
} from '../../shared/artifact-review-sleep'
import { agentLaunchOptionsFromCommand } from '../../shared/agent-command-launch-options'
import { normalizeAutomaticSessionCleanupProtection } from '../../shared/automatic-session-cleanup-protection'
import { conversationProfileOf } from '../../shared/conversation-resume-command'
import { resolveIdleAutoCloseGate } from '../../shared/idle-auto-close-settings'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { readPosixReceiverRow } from '../pty/posix-pty-foreground-group'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { readPaneAgentPresence } from '../runtime/prompt-queue-agent-presence'
import { getArtifactShareRecord } from './artifact-share-record-store'
import { saveArtifactReviewSleep } from './artifact-share-record-sleep'
import { activeArtifactShareScope } from './artifact-share-scope'
import { worktreeCreatedForPane } from './artifact-review-workspace-purge'
import { readReviewSessionCleanupHold } from './artifact-review-cleanup-hold'
import { validArtifactSourceReview } from './artifact-source-review'

export type ReviewSleepArmRequest = Pick<ArtifactWriteRequest, 'sourceKey' | 'review'> & {
  keepSession?: boolean
}

export async function launchFacts(
  runtime: OrcaRuntimeService,
  binding: { paneKey: string; worktreeId: string }
): Promise<Omit<ArtifactReviewSleep, 'state' | 'revision' | 'armedAt' | 'at'> | string> {
  const hook = runtime.getLastAgentHookRowForPane(binding.paneKey)
  const provider =
    hook?.agentType === 'claude' ? 'claude' : hook?.agentType === 'codex' ? 'codex' : null
  if (!provider) {
    return 'only Claude and Codex sessions sleep on a review'
  }
  try {
    if (
      runtime.resolveTerminalPane(binding.paneKey, binding.worktreeId).executionHostId !== 'local'
    ) {
      return 'a session running on another computer keeps running'
    }
  } catch {
    return 'its terminal could not be found on this computer'
  }
  const transcriptPath = hook?.providerSession?.transcriptPath
  const accountHome = transcriptPath
    ? conversationProfileOf(provider, transcriptPath)?.path
    : undefined
  const presence = await readPaneAgentPresence(runtime, { kind: 'pty', ...binding })
  const command =
    presence.kind === 'proven' && process.platform !== 'win32'
      ? (await readPosixReceiverRow(presence.proof.pid))?.command
      : undefined
  const options = command ? agentLaunchOptionsFromCommand(provider, command) : {}
  const described = await runtime.describeReviewSleepWorkspace(binding.worktreeId)
  // Why at publish: launch records are pruned after two days, and a decision can come later.
  const workspace =
    described?.kind === 'git' &&
    (await worktreeCreatedForPane(getProfileUserDataPath(), binding.worktreeId, binding.paneKey))
      ? { ...described, createdForSession: true, worktreeId: binding.worktreeId }
      : described && { ...described, worktreeId: binding.worktreeId }
  return {
    provider,
    ...(accountHome ? { accountHome } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...options,
    ...(workspace ? { cwd: workspace.path, workspace } : {})
  }
}

/** Why it will not sleep on this computer, or null when the wait ends in sleep. */
async function sleepRefusal(
  runtime: OrcaRuntimeService,
  binding: { paneKey: string; worktreeId: string }
): Promise<string | null> {
  const settings = runtime.getHeadlessSleepSettings()
  if (!resolveIdleAutoCloseGate(settings).act) {
    return 'Idle auto-close is not On (with the restore flood guard) on this computer, so it keeps running and the decision is queued to it'
  }
  if (!normalizeAutomaticSessionCleanupProtection(settings.automaticSessionCleanupProtection)) {
    return "this computer's cleanup protections are not set, so it keeps running and the decision is queued to it"
  }
  const hold = await readReviewSessionCleanupHold(runtime, binding)
  return hold
    ? `it is protected (${hold}), so it keeps running and the decision is queued to it`
    : null
}

/**
 * After a review publish from an agent pane, record the wait beside the share record: the session
 * stays live for `reviewWaitLiveMinutes`, then the hibernation timer sleeps it. Never throws: the
 * page is already published, and a missing wait only means today's live delivery.
 */
export async function armArtifactReviewSleep(
  runtime: OrcaRuntimeService,
  request: ReviewSleepArmRequest,
  now = Date.now()
): Promise<ArtifactSessionSleepNotice | undefined> {
  try {
    const userDataPath = getProfileUserDataPath()
    const active = activeArtifactShareScope(userDataPath, runtime.getArtifactApiOrigin())
    const record =
      active &&
      getArtifactShareRecord(active.profileId, userDataPath, request.sourceKey, active.scope)
    const binding = record?.sourceReview
    if (!active || !record || !validArtifactSourceReview(binding)) {
      return request.review
        ? { state: 'unavailable', reason: 'it was not published from an OmniConsole agent session' }
        : undefined
    }
    const expected = { slug: record.slug, sourceReview: binding }
    if (request.keepSession) {
      saveArtifactReviewSleep(
        active.profileId,
        userDataPath,
        request.sourceKey,
        active.scope,
        expected,
        null
      )
      return { state: 'kept' }
    }
    const facts = await launchFacts(runtime, binding)
    if (typeof facts === 'string') {
      saveArtifactReviewSleep(
        active.profileId,
        userDataPath,
        request.sourceKey,
        active.scope,
        expected,
        null
      )
      return { state: 'unavailable', reason: facts }
    }
    // Why no record when refused: without a wait nothing sleeps, wakes or is deleted by a Reject.
    const refusal = await sleepRefusal(runtime, binding)
    const sleep: ArtifactReviewSleep | null = refusal
      ? null
      : { ...facts, state: 'waiting', revision: binding.revision, armedAt: now, at: now }
    if (
      !saveArtifactReviewSleep(
        active.profileId,
        userDataPath,
        request.sourceKey,
        active.scope,
        expected,
        sleep
      )
    ) {
      return { state: 'unavailable', reason: 'the share record changed while it was being saved' }
    }
    return refusal
      ? { state: 'unavailable', reason: refusal }
      : {
          state: 'armed',
          liveMinutes: getEffectiveReviewWaitLiveMinutes(
            runtime.getHeadlessSleepSettings().reviewWaitLiveMinutes
          )
        }
  } catch {
    return undefined
  }
}

/** Adds the sleep notice to a successful share/update reply; older CLIs ignore the extra field. */
export async function withArtifactSessionSleep<T extends object>(
  runtime: OrcaRuntimeService,
  request: ReviewSleepArmRequest & { origin?: { paneKey?: string } },
  operation: { status: string; value?: T }
): Promise<typeof operation> {
  if (
    operation.status !== 'ok' ||
    !operation.value ||
    (!request.review && !request.origin?.paneKey)
  ) {
    return operation
  }
  const sessionSleep = await armArtifactReviewSleep(runtime, request)
  return sessionSleep ? { ...operation, value: { ...operation.value, sessionSleep } } : operation
}
