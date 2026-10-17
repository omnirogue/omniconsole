import { translate } from '@/i18n/i18n'
import { joinNames } from '@/lib/session-follow-up-messages'
import { actionLabel, nextStepAgentName } from '@/components/next-step/next-step-summary'
import { NEXT_STEP_SHAPE_GLYPH } from '../../../../shared/next-step-glyphs'
import {
  isSessionChainAgentStep,
  type SessionChain,
  type SessionChainStep
} from '../../../../shared/session-chain-types'

/** Where one pane sits inside the plan that launched it. */
export type SessionChainStepPlace = {
  /** 1-based position among the plan's compiled steps. */
  index: number
  total: number
  /** What the step is: "✨ Improve · Claude", "👤 Uma". */
  what: string
  /** Round position when the step is one of several rounds of the same action. */
  round: { index: number; total: number } | null
}

/** Reuses the strip vocabulary so a step reads the same here as in the plan popover. */
function stepWhat(step: SessionChainStep): string {
  if (!isSessionChainAgentStep(step)) {
    return `${NEXT_STEP_SHAPE_GLYPH.person} ${joinNames(
      [...step.handoff.recipients, ...(step.handoff.agentRecipients ?? [])].map(
        (recipient) => recipient.name
      )
    )}`
  }
  const agent = nextStepAgentName(step.agent)
  return step.presetId ? `${actionLabel(step.presetId)} · ${agent}` : agent
}

/**
 * The plan step this pane IS, not the one queued after it. Why only `launchedPaneKey`: a
 * source session's own work is not a plan step, and the plan queued after it is already
 * shown on its row — claiming a step position there would invent progress.
 */
export function sessionChainStepPlace(
  chain: SessionChain,
  paneKey: string | null
): SessionChainStepPlace | null {
  if (!paneKey) {
    return null
  }
  const index = chain.steps.findIndex(
    (step) => isSessionChainAgentStep(step) && step.launchedPaneKey === paneKey
  )
  const step = index === -1 ? undefined : chain.steps[index]
  if (!step) {
    return null
  }
  const round = isSessionChainAgentStep(step) ? (step.round ?? null) : null
  return {
    index: index + 1,
    total: chain.steps.length,
    what: stepWhat(step),
    round: round ? { index: round.index, total: round.total } : null
  }
}

/** "Step 2 of 4 · ✨ Improve · Claude", with "↻ 2/3" appended when the step is a round. */
export function sessionChainStepLine(place: SessionChainStepPlace): string {
  const head = translate('sessionActivity.stepOf', 'Step {{index}} of {{total}} · {{what}}', {
    index: place.index,
    total: place.total,
    what: place.what
  })
  return place.round
    ? `${head} · ${NEXT_STEP_SHAPE_GLYPH.rounds} ${place.round.index}/${place.round.total}`
    : head
}
