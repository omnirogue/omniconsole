import { toast } from 'sonner'
import { capturePickedHandoffFile } from '@/components/handoffs/handoff-client'
import type { SessionChainLaunchAccess } from '@/lib/session-chain-launch'
import { persistSessionChainOrThrow } from '@/lib/session-chain-registry'
import { chainAbortError, sleepUnlessAborted } from '@/lib/session-chain-support'
import { summaryFile, waitAndCapture } from '@/lib/session-follow-up-completion'
import {
  deliverSessionFollowUp,
  errorText,
  FollowUpException,
  type FollowUpHostIo
} from '@/lib/session-follow-up-delivery'
import { createFollowUpHostIo, createFollowUpHubIo } from '@/lib/session-follow-up-io'
import { followUpExceptionMessage, followUpSentToast } from '@/lib/session-follow-up-messages'
import { applyHandoffRouting } from '@/lib/session-follow-up-routing'
import { followUpStepState, type FollowUpStepState } from '@/lib/session-follow-up-step-state'
import type { ExactHandoffFile } from '../../../shared/console-handoff-contract'
import type { SessionFollowUpFilePin } from '../../../shared/session-follow-up-rule'

/** Deliver the captured pins, re-reading exact bytes after a restart and waiting out an offline host. */
async function deliver(
  state: FollowUpStepState,
  io: FollowUpHostIo,
  captured: Map<string, ExactHandoffFile>,
  signal: AbortSignal
): Promise<'delivered' | 'stopped'> {
  const bytes = async (pin: SessionFollowUpFilePin): Promise<ExactHandoffFile> => {
    const known = captured.get(pin.name)
    if (known) {
      return known
    }
    try {
      if (pin.generatedKind === 'transcript') {
        const file = state.view()?.step.handoff.transcriptFile
        if (!file) {
          throw new FollowUpException('files-changed', pin.name)
        }
        const data = Uint8Array.from(atob(file.contentBase64), (char) => char.charCodeAt(0))
        return capturePickedHandoffFile(new File([data], file.name))
      }
      if (pin.sourcePath === null) {
        const markdown = state.view()?.step.handoff.summaryMarkdown
        if (markdown === undefined) {
          throw new FollowUpException('files-changed', pin.name)
        }
        return await summaryFile(pin.name, markdown)
      }
      if (!(await io.exists(pin.sourcePath))) {
        throw new FollowUpException('files-changed', pin.name)
      }
      return await io.readExact(pin.sourcePath)
    } catch (error) {
      throw error instanceof FollowUpException
        ? error
        : new FollowUpException('unreadable', pin.name, errorText(error))
    }
  }
  for (;;) {
    try {
      return await deliverSessionFollowUp({
        current: () => state.live()?.step.handoff ?? null,
        save: (rule) => state.save(rule, { state: 'launching' }),
        hub: createFollowUpHubIo(),
        bytes,
        now: Date.now,
        sleep: (ms) => sleepUnlessAborted(ms, signal)
      })
    } catch (error) {
      const hostIssue =
        error instanceof FollowUpException &&
        (error.code === 'host-unreachable' || error.code === 'unreadable')
      if (hostIssue && (await state.whileHostOffline())) {
        continue
      }
      throw error
    }
  }
}

/**
 * Run a chain's handoff step: wait until the session's run is finished, require every
 * selected deliverable, capture exact bytes once, then deliver through the existing
 * handoff service. Missing files keep the rule waiting for the next stop; everything
 * else that stops it is recorded on the rule as a recoverable exception.
 */
/** A pane the runner already saw stop, so a fan-out member need not wait on it again. */
export type SourceStop = { handle: string; exited: boolean }

export async function runSessionFollowUpStep(
  access: SessionChainLaunchAccess,
  sourcePaneKeys: readonly string[],
  signal: AbortSignal,
  initialStop?: SourceStop
): Promise<void> {
  const first = access.getChain()
  const firstStep = first?.steps[first.currentIndex]
  if (!first || firstStep?.kind !== 'handoff') {
    return
  }
  const state = followUpStepState(access, firstStep.id, firstStep.handoff.revision, signal)
  const io = createFollowUpHostIo(first)
  try {
    const opening = state.view()
    if (opening?.step.handoff.exception && opening.chain.state !== 'cancelled') {
      await state.clearException()
    }
    const captured =
      state.view()?.step.handoff.capturedAt === undefined
        ? await waitAndCapture(state, io, sourcePaneKeys, signal, initialStop)
        : new Map<string, ExactHandoffFile>()
    // Existing repository handoffs prepare their branch here. Conversation deliveries retain
    // the exact captured attachments and message through the same route as direct chat.
    const routed = state.live()?.step.handoff
    if (routed) {
      await applyHandoffRouting(state, routed)
    }
    const outcome = await deliver(state, io, captured, signal)
    const done = state.view()
    // Why: a stop means a cancel, an edit or a retry took over; the runner must not re-enter this step.
    if (outcome === 'stopped' || !done || (signal.aborted && done.chain.state !== 'cancelled')) {
      throw chainAbortError()
    }
    const steps = done.chain.steps.map((step) =>
      step.id === done.step.id ? { ...done.step, status: 'delivered' as const } : step
    )
    const nextIndex = done.chain.currentIndex + 1
    const next = access.update({
      steps,
      currentIndex: nextIndex,
      state: nextIndex >= steps.length ? 'done' : 'waiting',
      error: null
    })
    toast.success(followUpSentToast(done.step.handoff))
    if (next) {
      try {
        await persistSessionChainOrThrow(next)
      } catch (error) {
        throw new FollowUpException('save-failed', '', errorText(error))
      }
    }
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw error
    }
    const exception =
      error instanceof FollowUpException
        ? error
        : new FollowUpException('run-failed', '', errorText(error))
    await state.recordException(exception).catch(() => undefined)
    throw new Error(followUpExceptionMessage(exception))
  }
}
