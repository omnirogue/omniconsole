import type { SessionChainLaunchAccess } from '@/lib/session-chain-launch'
import { persistSessionChainOrThrow } from '@/lib/session-chain-registry'
import { chainAbortError } from '@/lib/session-chain-support'
import { errorText, FollowUpException } from '@/lib/session-follow-up-delivery'
import {
  followUpHostLabel,
  isFollowUpHostOffline,
  waitForFollowUpHost,
  waitForFollowUpRecheck
} from '@/lib/session-follow-up-io'
import { followUpExceptionMessage } from '@/lib/session-follow-up-messages'
import type {
  SessionChain,
  SessionChainHandoffStep,
  SessionChainState
} from '../../../shared/session-chain-types'
import type { SessionFollowUpRule } from '../../../shared/session-follow-up-rule'

export type FollowUpStepView = { chain: SessionChain; step: SessionChainHandoffStep }
type ChainPatch = Partial<Pick<SessionChain, 'state' | 'error'>>

export type FollowUpStepState = ReturnType<typeof followUpStepState>

// Why: an unverifiable wait is re-checked on its own; the gaps grow so a gone pane costs little.
const RECHECK_DELAYS_MS = [15_000, 60_000, 300_000] as const

/**
 * One run's handle on its handoff step. It reads the step only while it is still the
 * same step and revision, persists every change before the next effect, and never
 * overrides a cancel: after one, saves only record what already happened. A run that
 * was stopped for anything else (an edit, a retry) can no longer save at all.
 */
export function followUpStepState(
  access: SessionChainLaunchAccess,
  stepId: string,
  revision: number,
  signal: AbortSignal
) {
  const view = (): FollowUpStepView | null => {
    const chain = access.getChain()
    const step = chain?.steps[chain.currentIndex]
    return chain &&
      step?.kind === 'handoff' &&
      step.id === stepId &&
      step.handoff.revision === revision
      ? { chain, step }
      : null
  }
  const live = (): FollowUpStepView | null => {
    const current = view()
    return current && current.chain.state !== 'cancelled' && !signal.aborted ? current : null
  }
  const mark = (state: SessionChainState): void => {
    if (live()) {
      access.update({ state })
    }
  }
  const save = async (rule: SessionFollowUpRule, patch: ChainPatch = {}): Promise<void> => {
    const current = view()
    if (!current) {
      return
    }
    // Why: the stopped run's record may be older than what replaced it; writing it would roll that back.
    if (signal.aborted && current.chain.state !== 'cancelled') {
      throw chainAbortError()
    }
    const steps = current.chain.steps.map((step) =>
      step.id === stepId ? { ...current.step, handoff: rule } : step
    )
    const next = access.update(
      current.chain.state === 'cancelled' ? { steps } : { steps, ...patch }
    )
    if (!next) {
      return
    }
    try {
      await persistSessionChainOrThrow(next)
    } catch (error) {
      throw new FollowUpException('save-failed', '', errorText(error))
    }
  }
  const recordException = async (
    exception: FollowUpException,
    patch: ChainPatch = {}
  ): Promise<void> => {
    const current = view()
    if (current) {
      const { code, subject, detail } = exception
      await save(
        { ...current.step.handoff, exception: { code, subject, detail, at: Date.now() } },
        patch
      )
    }
  }
  const clearException = async (): Promise<void> => {
    const current = view()
    if (current) {
      const { exception: _cleared, ...rule } = current.step.handoff
      await save(rule, {
        state: rule.capturedAt === undefined ? 'waiting' : 'launching',
        error: null
      })
    }
  }
  /** Show a known-offline SSH host, wait for it, then carry on; false when it is not known offline. */
  const whileHostOffline = async (): Promise<boolean> => {
    const current = view()
    if (!current || !isFollowUpHostOffline(current.chain)) {
      return false
    }
    const exception = new FollowUpException('host-unreachable', followUpHostLabel(current.chain))
    await recordException(exception, {
      state: 'failed',
      error: followUpExceptionMessage(exception)
    })
    await waitForFollowUpHost(current.chain, signal)
    if (!live()) {
      throw chainAbortError()
    }
    await clearException()
    return true
  }
  /** Show that the run's outcome could not be verified, wait, then let the caller check again. */
  const whileUnverifiable = async (detail: string, attempt: number): Promise<void> => {
    const current = view()
    if (!current) {
      throw chainAbortError()
    }
    const exception = new FollowUpException(
      'unverifiable',
      followUpHostLabel(current.chain),
      detail
    )
    await recordException(exception, {
      state: 'failed',
      error: followUpExceptionMessage(exception)
    })
    const delay = RECHECK_DELAYS_MS[Math.min(attempt, RECHECK_DELAYS_MS.length - 1)]!
    await waitForFollowUpRecheck(current.chain, signal, delay)
    if (!live()) {
      throw chainAbortError()
    }
    await clearException()
  }
  return {
    view,
    live,
    mark,
    save,
    recordException,
    clearException,
    whileHostOffline,
    whileUnverifiable
  }
}
