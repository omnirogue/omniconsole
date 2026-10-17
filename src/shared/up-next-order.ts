/**
 * The order rules of an Up next chain: who a prompt belongs to, what each block is
 * numbered, where the track ends, and what may still be added.
 *
 * Pure and shared on purpose. The host view is the source of truth, but the renderer
 * numbers its own optimistic list with THESE functions, so "2.1" never means two
 * things in one build. The algorithms are the agreed ones from
 * `pages/mockup-next-action-panel.html` (`targetOf`, `number`, the add-bar rule).
 */

import {
  UP_NEXT_REASON_KEYS,
  UP_NEXT_REFUSAL_KEYS,
  upNextIsFinished,
  type UpNextBlockKind,
  type UpNextBlockState,
  type UpNextCanAdd,
  type UpNextHeaderState,
  type UpNextPersonRelationship,
  type UpNextPromptTarget
} from './up-next-types'
import { upNextDueRefusal } from './up-next-person-due'

/**
 * The least a block must say for the order rules to hold: what kind it is, and — for a
 * person — whether it returns the work. Drafts satisfy it as well as committed blocks.
 */
export type UpNextOrderBlock = {
  id: string
  kind: UpNextBlockKind
  /** `draft` marks a block still being composed: the only kind a send may leave behind it. */
  state?: UpNextBlockState
  relationship?: UpNextPersonRelationship
  /** A person's due, so a change to it can be judged against the one it replaces. */
  receive?: { dueAt?: string }
}

export type UpNextNumbering = {
  /** The number of each block, in the order it was given. */
  numbers: string[]
  /** The block a prompt nests under, or null for a top-level block. */
  parentIds: (string | null)[]
  /** Top-level blocks: stages, people and Done. The "of N" a stage counter reads. */
  topLevel: number
}

/**
 * Who the prompt at `index` goes to: the nearest agent stage above it, the current
 * agent when it resumes after a person REVIEW, or — with nothing above it — the
 * conversation's own agent. A Person block nobody has ticked yet waits by default when
 * anything follows it (`up-next-person-send.ts`), so a prompt below it resumes after it too.
 *
 * A Done or handoff block above a prompt answers as a stage. Nothing may follow either
 * of them, so it is unreachable in a chain the engine built; it is kept because a
 * caller may number a list it is still editing, and a target is better than a throw.
 */
export function upNextTargetOf(
  blocks: readonly UpNextOrderBlock[],
  index: number
): UpNextPromptTarget {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const block = blocks[cursor]!
    if (block.kind === 'prompt') {
      continue
    }
    if (block.kind === 'person' && block.relationship !== 'handoff') {
      return { kind: 'resume-after-review', blockId: block.id }
    }
    return { kind: 'stage', blockId: block.id }
  }
  return { kind: 'current' }
}

/**
 * "2" for a block, "2.1" for the first prompt nested under it. A prompt to the current
 * agent is numbered in its own run, so the Now row's prompts read 1, 2, 3; the counter
 * restarts whenever the prompt above belonged to someone else.
 */
export function upNextNumber(blocks: readonly UpNextOrderBlock[]): UpNextNumbering {
  const numbers: string[] = []
  const parentIds: (string | null)[] = []
  let topLevel = 0
  let nested = 0
  let previousParent: number | undefined
  blocks.forEach((block, index) => {
    if (block.kind !== 'prompt') {
      topLevel += 1
      numbers[index] = String(topLevel)
      parentIds[index] = null
      previousParent = undefined
      return
    }
    const target = upNextTargetOf(blocks, index)
    const parent =
      target.kind === 'current'
        ? -1
        : blocks.findIndex((candidate) => candidate.id === target.blockId)
    if (parent !== previousParent) {
      nested = 0
      previousParent = parent
    }
    nested += 1
    parentIds[index] = parent < 0 ? null : blocks[parent]!.id
    numbers[index] = parent < 0 ? String(nested) : `${numbers[parent]!}.${nested}`
  })
  return { numbers, parentIds, topLevel }
}

/** An end cap: the track stops under it. A handoff moves ownership; Done finishes. */
export function upNextIsEndCap(block: UpNextOrderBlock): boolean {
  return block.kind === 'done' || (block.kind === 'person' && block.relationship === 'handoff')
}

/**
 * Why CHANGING a block is refused, or undefined. `upNextCanAdd` keeps the end of the track
 * terminal while blocks are added; this keeps it terminal when a block the person already
 * wrote is turned into one. Unticking "wait for their OK" with only COMPOSED blocks after it is
 * allowed: those stay drafts that never run from there (`upNextWontRun`). Queued or held work
 * after it would still run, and the people are the plan's own finish, so a chain shown as
 * [hand off, stage] could only ever execute the other way round: that change is refused. A
 * person's due changed to a moment already past is refused too (`upNextDueRefusal`).
 */
export function upNextChangeRefusal(
  blocks: readonly UpNextOrderBlock[],
  blockId: string,
  patch: {
    kind: UpNextBlockKind
    relationship?: UpNextPersonRelationship | null
    receive?: { dueAt?: string }
  },
  now: number = Date.now()
): string | undefined {
  const index = blocks.findIndex((block) => block.id === blockId)
  const buries = index !== -1 && blocks.slice(index + 1).some((block) => block.state !== 'draft')
  if (patch.kind !== 'person') {
    return undefined
  }
  return patch.relationship === 'handoff' && buries
    ? UP_NEXT_REFUSAL_KEYS.pastTerminal
    : upNextDueRefusal(patch.receive?.dueAt, blocks[index]?.receive?.dueAt, now)
}

/**
 * Which add buttons are live, and the message key for every one that is not. A handoff
 * ends the track (nothing may follow it); Done is last (a block may only be added
 * before it); a finished session takes nothing at all.
 */
export function upNextCanAdd(
  blocks: readonly UpNextOrderBlock[],
  headerState: UpNextHeaderState
): UpNextCanAdd {
  const handoff = blocks.some(
    (block) => block.kind === 'person' && block.relationship === 'handoff'
  )
  const done = blocks.some((block) => block.kind === 'done')
  const closed = upNextIsFinished(headerState)
  const work = handoff
    ? UP_NEXT_REASON_KEYS.handoffTerminal
    : done
      ? UP_NEXT_REASON_KEYS.doneLastRemoveToAdd
      : undefined
  const reasons: Partial<Record<UpNextBlockKind, string>> = {}
  const settle = (kind: UpNextBlockKind, reason: string | undefined): boolean => {
    const refusal = closed ? UP_NEXT_REASON_KEYS.sessionClosed : reason
    if (refusal) {
      reasons[kind] = refusal
    }
    return !refusal
  }
  return {
    prompt: settle('prompt', work),
    agent: settle('agent', work),
    person: settle(
      'person',
      handoff
        ? UP_NEXT_REASON_KEYS.handoffEndsTrack
        : done
          ? UP_NEXT_REASON_KEYS.doneLast
          : undefined
    ),
    done: settle(
      'done',
      done
        ? UP_NEXT_REASON_KEYS.doneAlreadyInTrack
        : handoff
          ? UP_NEXT_REASON_KEYS.handoffEndsTrack
          : undefined
    ),
    reasons
  }
}
