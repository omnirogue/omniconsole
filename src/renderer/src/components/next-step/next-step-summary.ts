import { translate } from '@/i18n/i18n'
import { joinNames } from '@/lib/session-follow-up-messages'
import { getAgentCatalog } from '@/lib/agent-catalog'
import {
  clampNextStepRounds,
  isNextStepParallel,
  nextStepAgents,
  nextStepPeople,
  type NextStepOutcomeFinish,
  type NextStepDraft
} from '../../../../shared/next-step-draft'
import { NEXT_STEP_ACTION_GLYPH, NEXT_STEP_SHAPE_GLYPH } from '../../../../shared/next-step-glyphs'
import { SESSION_ACTION_PRESET_LABELS } from '../../../../shared/session-action-presets'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SessionActionPresetId } from '../../../../shared/session-action-presets'
import {
  isSessionChainAgentStep,
  type SessionChain,
  type SessionChainStep
} from '../../../../shared/session-chain-types'
import { readSessionRun } from '../../../../shared/session-run-lifecycle'

/** The catalog label of an agent, or its id when the catalog does not know it. */
export function nextStepAgentName(agent: TuiAgent): string {
  return getAgentCatalog().find((entry) => entry.id === agent)?.label ?? agent
}

/** Glyphs that say what is happening; they never ask the person to choose a concept. */
export const NEXT_STEP_GLYPH = {
  one: NEXT_STEP_SHAPE_GLYPH.handoff,
  parallel: NEXT_STEP_SHAPE_GLYPH.parallel,
  rounds: NEXT_STEP_SHAPE_GLYPH.rounds
} as const

/** "✨ Improve" — the action with its glyph. */
export function actionLabel(presetId: SessionActionPresetId): string {
  return `${NEXT_STEP_ACTION_GLYPH[presetId]} ${SESSION_ACTION_PRESET_LABELS[presetId]}`
}

/** One step of a strip: "✨ Improve · Claude", "👤 Uma", "🤖🤖 3 Reviews". */
function stripStep(step: SessionChainStep): string {
  if (!isSessionChainAgentStep(step)) {
    return `${NEXT_STEP_SHAPE_GLYPH.person} ${joinNames([...step.handoff.recipients, ...(step.handoff.agentRecipients ?? [])].map((r) => r.name))}`
  }
  const action = step.presetId ? actionLabel(step.presetId) : nextStepAgentName(step.agent)
  return step.presetId ? `${action} · ${nextStepAgentName(step.agent)}` : action
}

/**
 * The saved chain as a strip: "Current → ✨ Improve · Claude → 👤 Uma → Done". A fan-out
 * folds into one step ("🤖🤖 3 Reviews"), rounds into one ("↻ 3 × ✨ Improve").
 */
export function describeSessionChainStrip(chain: SessionChain): string[] {
  const parts: string[] = [translate('nextStep.stripCurrent', 'Current')]
  const seen = new Set<string>()
  for (const step of chain.steps) {
    if (step.group) {
      if (seen.has(step.group)) {
        continue
      }
      seen.add(step.group)
      const members = chain.steps.filter((candidate) => candidate.group === step.group)
      const agents = members.filter(isSessionChainAgentStep)
      const presets = new Set(agents.map((member) => member.presetId ?? ''))
      const [only] = [...presets]
      const fold =
        agents.length > 1 && presets.size === 1 && only
          ? translate('nextStep.stripFanOut', '{{glyphs}} {{count}} × {{action}}', {
              glyphs: NEXT_STEP_SHAPE_GLYPH.agent.repeat(Math.min(agents.length, 3)),
              count: agents.length,
              action: actionLabel(only as SessionActionPresetId)
            })
          : null
      // Why: a fold never hides a person who is in the same fan-out.
      const others = members.filter((member) => !isSessionChainAgentStep(member)).map(stripStep)
      parts.push(
        (fold ? [fold, ...others] : members.map(stripStep)).join(
          ` ${NEXT_STEP_SHAPE_GLYPH.parallel} `
        )
      )
      continue
    }
    if (isSessionChainAgentStep(step) && step.round) {
      if (seen.has(step.round.key)) {
        continue
      }
      seen.add(step.round.key)
      parts.push(`${NEXT_STEP_SHAPE_GLYPH.rounds} ${step.round.total} × ${stripStep(step)}`)
      continue
    }
    parts.push(stripStep(step))
  }
  parts.push(sessionChainEndingLabel(chain))
  return parts
}

/** The last word of a plan: where the work ends up once its steps are through. */
export function sessionChainEndingLabel(chain: Pick<SessionChain, 'end'>): string {
  return chain.end === 'me'
    ? translate('nextStep.backToMe', 'Back to me')
    : chain.end === 'done'
      ? translate('nextStep.endSession', 'End session')
      : // Why: a plan saved before endings existed closes nothing; it only stops.
        translate('nextStep.stripDone', 'Done')
}

function actorName(step: SessionChainStep): string {
  return isSessionChainAgentStep(step)
    ? nextStepAgentName(step.agent)
    : joinNames(
        [...step.handoff.recipients, ...(step.handoff.agentRecipients ?? [])].map(
          (recipient) => recipient.name
        )
      )
}

function roundsText(total: number): string {
  return translate('nextStep.rounds', '{{glyph}} {{count}} rounds', {
    glyph: NEXT_STEP_GLYPH.rounds,
    count: total
  })
}

/** "Current → Claude", "Current ⑂ Claude, Codex, Uma", "Improve · Claude · ↻ 3 rounds". */
export function describeNextStepDraft(draft: NextStepDraft): string {
  const names = draft.recipients.map((recipient) =>
    recipient.kind === 'agent'
      ? recipient.presetId
        ? `${actionLabel(recipient.presetId)} · ${nextStepAgentName(recipient.agent)}`
        : nextStepAgentName(recipient.agent)
      : `${NEXT_STEP_SHAPE_GLYPH.person} ${recipient.name}`
  )
  if (names.length === 0) {
    return translate('nextStep.summaryEmpty', 'Choose who gets this next.')
  }
  const glyph = isNextStepParallel(draft) ? NEXT_STEP_GLYPH.parallel : NEXT_STEP_GLYPH.one
  const line = translate('nextStep.summaryLine', 'Current {{glyph}} {{names}}', {
    glyph,
    names: joinNames(names)
  })
  const [only] = nextStepAgents(draft)
  const rounds = !isNextStepParallel(draft) && only && only.rounds > 1 ? only.rounds : 0
  const head = rounds > 1 ? `${line} · ${roundsText(rounds)}` : line
  const after = draft.after
  const levels = new Map<string, string[]>()
  after.forEach((step, index) => {
    const key = step.level === undefined ? `step-${index}` : `level-${step.level}`
    const label =
      step.kind === 'person'
        ? `${NEXT_STEP_SHAPE_GLYPH.person} ${step.name || '…'}`
        : `${actionLabel(step.presetId)} · ${nextStepAgentName(step.actor.agent)}`
    levels.set(key, [...(levels.get(key) ?? []), label])
  })
  const tail = [...levels.values()].map((names) => names.join(` ${NEXT_STEP_GLYPH.parallel} `))
  const ending =
    draft.end === 'done'
      ? translate('nextStep.endSessionGlyph', '✓ End session')
      : translate('nextStep.endMe', '↩ Back to me')
  const line2 = [head, ...tail, ending].join(` ${NEXT_STEP_GLYPH.one} `)
  // Why: the cost is said before the click — how many sessions this starts.
  const sessions = nextStepSessionCount(draft)
  return sessions > 1
    ? `${line2} · ${translate('nextStep.startsSessions', 'starts {{count}} sessions', { count: sessions })}`
    : line2
}

/** How many agent sessions the draft starts: every recipient's rounds, then every later agent step's. */
export function nextStepSessionCount(draft: NextStepDraft): number {
  const parallel = isNextStepParallel(draft)
  const agents = nextStepAgents(draft)
  let count = agents.reduce(
    (sum, agent) => sum + (parallel ? 1 : clampNextStepRounds(agent.rounds)),
    0
  )
  for (const step of draft.after) {
    if (step.kind === 'agent') {
      const parallel =
        step.level !== undefined &&
        draft.after.filter((entry) => entry.level === step.level).length > 1
      count += parallel ? 1 : clampNextStepRounds(step.rounds)
    }
  }
  return count
}

/** One agent recipient's own line: "Improve · Claude · xhigh · ↻ 3 rounds". */
export function describeNextStepAgent(
  recipient: ReturnType<typeof nextStepAgents>[number],
  parallel: boolean
): string {
  const parts = [
    recipient.presetId ? actionLabel(recipient.presetId) : null,
    nextStepAgentName(recipient.agent),
    recipient.model ?? null,
    !parallel && recipient.rounds > 1 ? roundsText(recipient.rounds) : null
  ]
  return parts.filter((part): part is string => !!part).join(' · ')
}

export function describeNextStepPeople(draft: NextStepDraft): string {
  return joinNames(nextStepPeople(draft).map((person) => person.name))
}

/**
 * The saved chain as a status line: what is queued after the session. "→ Claude",
 * "⑂ Claude, Codex, then Uma", "↻ 3 rounds · Claude". Finished steps are left out.
 */
export function describeSessionChain(chain: SessionChain, now = Date.now()): string {
  const phase = chain.outcomeSet
    ? readSessionRun(chain.outcomeSet, { now, planVersion: chain.planVersion ?? 1 }).phase
    : null
  // "Needs you" is an open request to the owner and nothing else; a failed plan says it failed.
  if (phase === 'needs-you') {
    return translate('nextStep.chainNeedsYou', 'Next step needs you')
  }
  // A finished or cancelled plan has no queue: a step it never reached is not still to come.
  if (phase === 'completed' || chain.state === 'done' || chain.state === 'cancelled') {
    return ''
  }
  if (phase === 'failed' || chain.state === 'failed') {
    return translate('nextStep.chainFailed', 'Next step failed')
  }
  const pending = chain.steps.filter((step) => step.status === 'queued')
  if (pending.length === 0) {
    return ''
  }
  const first = pending[0]!
  const round = isSessionChainAgentStep(first) ? (first.round ?? null) : null
  const group = first.group
    ? pending.filter((step) => step.group === first.group)
    : round
      ? pending.filter((step) => isSessionChainAgentStep(step) && step.round?.key === round.key)
      : [first]
  const rest = pending.filter((step) => !group.includes(step))
  const names = joinNames([...new Set(group.map(actorName))])
  const head = first.group
    ? `${NEXT_STEP_GLYPH.parallel} ${names}`
    : round
      ? `${NEXT_STEP_GLYPH.rounds} ${translate('nextStep.roundsOf', '{{count}} rounds · {{name}}', { count: round.total, name: names })}`
      : `${NEXT_STEP_GLYPH.one} ${names}`
  if (rest.length === 0) {
    return head
  }
  return translate('nextStep.thenMore', '{{head}}, then {{names}}', {
    head,
    names: joinNames([...new Set(rest.map(actorName))])
  })
}

/** Where an outcome lands: back to me unless a teammate (or a legacy GitHub finish) takes it. */
export function outcomeFinishLabel(finish: NextStepOutcomeFinish | null): string {
  switch (finish?.kind) {
    case 'person':
      if (!finish.personName) {
        return translate('nextStep.chooseHandoffPerson', 'Choose who receives it')
      }
      // Why: feedback comes back to me; only ownership is a handoff.
      return finish.disposition === 'feedback'
        ? translate('nextStep.sendToForReview', 'Send to {{name}} for review', {
            name: finish.personName
          })
        : translate('nextStep.handOffTo', 'Hand off to {{name}}', { name: finish.personName })
    case 'github': {
      const action =
        finish.action === 'create-pr'
          ? translate('nextStep.createPr', 'Create PR')
          : finish.action === 'merge'
            ? translate('nextStep.merge', 'Merge')
            : translate('nextStep.mergeAndDeploy', 'Merge & deploy')
      return [action, finish.repository].filter(Boolean).join(' · ')
    }
    case 'complete':
    case 'my-review':
    case undefined:
      // Why: an unset finish is saved as Me, so it reads as Me before Save too.
      return translate('nextStep.backToMe', 'Back to me')
  }
}
