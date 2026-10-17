import { translate } from '@/i18n/i18n'
import {
  approveSessionOutcomeReview,
  commitSessionOutcomes,
  getOutcomeProgress
} from '@/components/next-step/next-step-outcome-client'
import type { SessionChain } from '../../../../shared/session-chain-types'
import {
  sessionOutcomeDefinition,
  type SessionOutcomeDefinition
} from '../../../../shared/session-outcome-types'
import { doneWhenFacts } from './done-when-facts'

/** Editable prose and queued prompts; launched actions retain their original instructions. */
export type OutcomeEdit = {
  sentence: string
  conditions: { key: string; label: string }[]
  actions: { key: string; title: string; instruction: string; readOnly: boolean }[]
}

export function outcomeEditFrom(chain: SessionChain | null | undefined): OutcomeEdit {
  return {
    sentence: chain?.outcomeSet?.outcomes[0]?.title ?? '',
    conditions: doneWhenFacts(chain).items.map((item) => ({ key: item.key, label: item.label })),
    actions: (chain?.outcomeSet?.outcomes ?? []).flatMap((outcome) =>
      outcome.actions.map((action) => ({
        key: `${outcome.id}:${action.id}`,
        title: outcome.title,
        instruction: action.instruction,
        readOnly:
          Boolean(chain?.outcomeSet?.completion) ||
          (chain?.outcomeSet?.attempts ?? []).some(
            (attempt) =>
              attempt.outcomeId === outcome.id &&
              attempt.actionId === action.id &&
              ['launching', 'running', 'unverifiable', 'completed'].includes(attempt.state)
          )
      }))
    )
  }
}

/**
 * The two calls this editor needs, injectable so a test drives the CAS path without a host. The
 * reload is the host's own progress read: after a conflict the person must see what IS saved.
 */
export type OutcomeEditDoor = {
  commit: typeof commitSessionOutcomes
  reload: (chain: SessionChain) => Promise<SessionChain>
  /** The owner's own review, approved through the door the Next step panel already uses. */
  approveReview?: typeof approveSessionOutcomeReview
}

export function outcomeEditDoor(): OutcomeEditDoor {
  return {
    approveReview: approveSessionOutcomeReview,
    commit: commitSessionOutcomes,
    reload: async (chain) => (await getOutcomeProgress(chain.id, chain)).chain
  }
}

/** The host's sentence for a lost race; the editor shows it verbatim and reloads. */
export function isOutcomeRevisionConflict(message: string): boolean {
  return /revision conflict/i.test(message)
}

/** Preserve action identity, dependencies and evidence targets while editing pending instructions. */
export function outcomeEditDefinitions(
  chain: SessionChain,
  edit: OutcomeEdit
): SessionOutcomeDefinition[] {
  const labels = new Map(edit.conditions.map((entry) => [entry.key, entry.label.trim()]))
  const prompts = new Map(
    edit.actions
      .filter((action) => !action.readOnly)
      .map((action) => [action.key, action.instruction.trim()])
  )
  const outcomes = chain.outcomeSet?.outcomes ?? []
  return outcomes.map((outcome, index) => {
    const definition = sessionOutcomeDefinition(outcome)
    const actions = definition.actions.map((action) => ({
      ...action,
      instruction: prompts.get(`${outcome.id}:${action.id}`) ?? action.instruction
    }))
    const instructionAction = definition.actions.findIndex(
      (action) => action.instruction === definition.instructions
    )
    return {
      ...definition,
      actions,
      ...(instructionAction !== -1
        ? { instructions: actions[instructionAction]!.instruction }
        : {}),
      ...(index === 0 ? { title: edit.sentence.trim() } : {}),
      conditions: definition.conditions.map((condition) => {
        const label = labels.get(`${outcome.id}:${condition.id}`)
        if (label === undefined) {
          return condition
        }
        const { label: _previous, ...rest } = condition
        return label ? { ...rest, label } : rest
      })
    }
  })
}

export function outcomeEditProblem(edit: OutcomeEdit): string | null {
  if (edit.actions.some((action) => !action.instruction.trim())) {
    return translate(
      'nextAction.actionInstructionRequired',
      'Enter a prompt for every next action.'
    )
  }
  return edit.sentence.trim()
    ? null
    : translate('nextAction.outcomeSentenceRequired', 'Say what this conversation is pursuing.')
}

/**
 * The first outcome of a conversation, from the sentence alone: the shape the engine's own first
 * commit lowers to when nothing is queued yet (`upNextPlanOf` → "I have reviewed the result",
 * finish `my-review`). A definition needs at least one condition, and this one is the only
 * criterion the person's sentence can honestly carry — the work comes back to them. No
 * instructions and no actions: with no step to carry them the host refuses both.
 */
export function firstOutcomeDefinition(sentence: string): SessionOutcomeDefinition {
  const id = crypto.randomUUID()
  return {
    id,
    title: sentence.trim(),
    finish: 'my-review',
    outputKind: 'work',
    dependsOn: [],
    conditions: [
      {
        id: 'my-review',
        kind: 'review',
        target: id,
        label: translate('nextAction.myReviewCondition', 'I have reviewed the result')
      }
    ],
    actions: []
  }
}

/**
 * Commit the reword through the same door every other outcome change uses, with the revision the
 * editor was opened against. A stale revision is the host's refusal to guess; the caller shows the
 * host's message and takes the reloaded chain.
 *
 * A chain with no outcome set yet is CREATED through the same door: `sessionChain.commitOutcomes`
 * revises `undefined` at revision 0 (`reviseSessionOutcomeSet`), and a chain the host has never
 * seen is adopted on that commit — the work-plan door already relies on both.
 */
export async function commitOutcomeEdit(input: {
  chain: SessionChain
  edit: OutcomeEdit
  door: OutcomeEditDoor
}): Promise<SessionChain> {
  const { chain, edit, door } = input
  const problem = outcomeEditProblem(edit)
  if (problem) {
    throw new Error(problem)
  }
  const set = chain.outcomeSet
  return door.commit({
    chain,
    expectedRevision: set?.revision ?? 0,
    outcomes: set ? outcomeEditDefinitions(chain, edit) : [firstOutcomeDefinition(edit.sentence)]
  })
}
