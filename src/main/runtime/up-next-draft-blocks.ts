/**
 * Composed-but-not-queued blocks, as blocks.
 *
 * A draft is exactly what the person authored and nothing else: no state to read, no
 * progress, no step. It renders beside the queued blocks so the composer shows one list —
 * dashed rows in the UI — and `commit` is the only thing that turns one into work.
 */

import type {
  UpNextAgentBlock,
  UpNextBlock,
  UpNextDoneBlock,
  UpNextPersonBlock,
  UpNextPromptBlock
} from '../../shared/up-next-types'
import { UP_NEXT_BLOCK_ID } from '../../shared/up-next-types'
import type { UpNextDraftEntry } from '../../shared/up-next-draft-schema'
import { upNextAgentIntent, upNextStageOutput } from '../../shared/up-next-agent-intent'
import { initialsOf } from './up-next-blocks'

const DRAFT = { state: 'draft', locked: false, number: '' } as const

/** Addressed by the draft store: still the person's to move or remove, held or not. */
export function isUpNextDraftBlockId(id: string): boolean {
  return id.startsWith(UP_NEXT_BLOCK_ID.draft)
}

/** The seats a shape runs with when the person has not said; one for a lone agent. */
export function upNextDraftWidth(input: { shape?: string; n?: number }): number {
  if (input.n && input.n > 0) {
    return Math.trunc(input.n)
  }
  return !input.shape || input.shape === 'solo' ? 1 : 3
}

export function upNextDraftBlock(entry: UpNextDraftEntry): UpNextBlock {
  const input = entry.input
  const state = entry.held ? ('waiting' as const) : DRAFT.state
  const heldFor = entry.held
    ? {
        heldFor: {
          kind: 'review' as const,
          blockId: `${UP_NEXT_BLOCK_ID.step}${entry.held.reviewStepId}`
        }
      }
    : {}
  if (input.kind === 'prompt') {
    const block: UpNextPromptBlock = {
      ...DRAFT,
      state,
      ...heldFor,
      id: entry.id,
      kind: 'prompt',
      text: input.text,
      // The real target is computed from where the block sits, like every other prompt.
      target: { kind: 'current' },
      ...(input.when ? { when: input.when } : {})
    }
    return block
  }
  if (input.kind === 'agent') {
    const block: UpNextAgentBlock = {
      ...DRAFT,
      state,
      ...heldFor,
      id: entry.id,
      kind: 'agent',
      template: input.template,
      shape: input.shape ?? 'solo',
      n: upNextDraftWidth(input),
      instruction: input.instruction ?? '',
      output: upNextStageOutput(input.template),
      intent: upNextAgentIntent(input.template),
      advanced: input.advanced ?? {},
      promptCount: 0
    }
    return block
  }
  if (input.kind === 'person') {
    const block: UpNextPersonBlock = {
      ...DRAFT,
      state,
      ...heldFor,
      id: entry.id,
      kind: 'person',
      relationship: input.relationship ?? null,
      people: [
        ...(input.people ?? []),
        // Ids with no name: named by their id until the picker supplies one.
        ...(input.peopleIds ?? [])
          .filter((id) => !(input.people ?? []).some((person) => person.id === id))
          .map((id) => ({ id, name: id }))
      ].map((person) => ({
        id: person.id,
        name: person.name,
        initials: initialsOf(person.name)
      })),
      receive: {
        // Why true: a send always carries everything; an older draft's stored `false` still reads back.
        files: input.receive?.files ?? true,
        transcript: input.receive?.transcript ?? true,
        ...(input.receive?.note ? { note: input.receive.note } : {}),
        createTaskCard: input.receive?.createTaskCard ?? false,
        ...(input.receive?.attachTaskId ? { attachTaskId: input.receive.attachTaskId } : {}),
        ...(input.receive?.dueAt ? { dueAt: input.receive.dueAt } : {}),
        ...(input.receive?.artifact ? { artifact: { ...input.receive.artifact } } : {})
      },
      // Every named reviewer gets their own request and their own condition, so the track
      // continues only when all of them have replied.
      ...(input.relationship === 'review' ? { waitRule: 'all' as const } : {})
    }
    return block
  }
  const block: UpNextDoneBlock = {
    ...DRAFT,
    state,
    ...heldFor,
    id: entry.id,
    kind: 'done',
    finish: input.finish ?? 'close',
    ...(input.folderId ? { folderId: input.folderId } : {})
  }
  return block
}

/**
 * Drafts placed among the blocks already queued: a draft anchored to a block follows it,
 * a `head` draft is the next thing the current agent hears (ahead of every stage, behind the
 * prompts already waiting for it — which is what `/next …` means), and everything else goes
 * to the end. Done is last, always: it is the terminal block.
 */
export function upNextWithDrafts(
  committed: readonly UpNextBlock[],
  entries: readonly UpNextDraftEntry[]
): UpNextBlock[] {
  const drafts = entries.map((entry) => ({ entry, block: upNextDraftBlock(entry) }))
  const anchored = (id: string | undefined): UpNextBlock[] =>
    drafts
      .filter((draft) => !draft.entry.place && (draft.entry.afterBlockId ?? undefined) === id)
      .map((draft) => draft.block)
  const known = new Set(committed.map((block) => block.id))
  const queuedHead = committed.filter(
    (block) => block.kind === 'prompt' && block.target.kind === 'current'
  )
  const rest = committed.filter((block) => !queuedHead.includes(block))
  const ordered = [
    ...queuedHead.flatMap((block) => [block, ...anchored(block.id)]),
    ...drafts.filter((draft) => draft.entry.place === 'head').map((draft) => draft.block),
    ...rest.flatMap((block) => [block, ...anchored(block.id)]),
    ...drafts
      .filter(
        (draft) =>
          !draft.entry.place && (!draft.entry.afterBlockId || !known.has(draft.entry.afterBlockId))
      )
      .map((draft) => draft.block)
  ]
  const done = ordered.filter((block) => block.kind === 'done')
  return done.length ? [...ordered.filter((block) => block.kind !== 'done'), ...done] : ordered
}
