/**
 * What "Send to a person" commits — through the rule the engine already has.
 *
 * The block offers one choice (`up-next-person-send.ts`): ticked is a review (`feedback`, asked of
 * every named person, the blocks after it held until all of them say OK); unticked is a hand off
 * (ownership moves and the track ends). Either way it sends everything: the work files, the
 * summary and the full conversation, whatever an older draft once stored for them.
 */

import type { WorkPlanFinishPeople } from '../../shared/work-plan-types'
import {
  UP_NEXT_REFUSAL_KEYS,
  type UpNextAgentBlock,
  type UpNextPersonBlock,
  type UpNextView
} from '../../shared/up-next-types'

export function upNextFinishWith(block: UpNextPersonBlock): WorkPlanFinishPeople {
  if (!block.relationship) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.needsRelationship)
  }
  if (!block.people.length) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.needsPerson)
  }
  return {
    people: block.people.map((person) => ({ id: person.id, name: person.name })),
    disposition: block.relationship === 'handoff' ? 'ownership' : 'feedback',
    action: block.relationship === 'handoff' ? 'edit' : 'review',
    receive: {
      files: true,
      transcript: true,
      ...(block.receive.note ? { note: block.receive.note } : {}),
      ...(block.receive.attachTaskId ? { taskId: block.receive.attachTaskId } : {}),
      ...(block.receive.dueAt ? { dueAt: block.receive.dueAt } : {}),
      ...(block.receive.artifact ? { artifact: { ...block.receive.artifact } } : {})
    }
  }
}

/**
 * The Outcome a first commit pursues, in the person's own words from the first stage. A typed
 * note equal to it still reaches the people as written: the rule marks it `noteAuthored`.
 */
export function upNextCommitTitle(view: UpNextView, stages: readonly UpNextAgentBlock[]): string {
  const first = stages.length ? (stages[0]!.instruction.split('\n')[0]?.trim() ?? '') : ''
  return (
    [first, view.notation].map((title) => title.slice(0, 200)).find((title) => title.trim()) ??
    'Up next'
  )
}
