import type { UpNextReviewWaiting } from './up-next-review-waiting'
export type { UpNextReviewWaiting } from './up-next-review-waiting'
/**
 * Up next — ONE ordered read/write model for everything scheduled on one conversation.
 *
 * A conversation has one Outcome line and one Up next chain. The chain is an ordered
 * list of blocks the person edits BEFORE they run: another prompt to an agent, a new
 * agent stage, a person, and the terminal Done. It is a PROJECTION, never a second
 * engine: prompt blocks are prompt-queue entries (`prompt-queue-types.ts`) or prompts
 * attached to a compiled step, agent and person blocks are the current plan version's
 * steps (`session-chain-types.ts`), and Done is the session finish intent
 * (`session-finish-intent.ts`). Nothing here invents a queue of its own.
 *
 * Every state on a block is read from AUTHORITATIVE runtime facts — attempts, step
 * status, delivery receipts — never from what the person just clicked. The host view
 * is the source of truth; the pure functions below exist so the renderer can number,
 * summarize and notate exactly the same list without re-deriving the rules.
 *
 * Invariants it must not break (`docs/outcome-model-frozen.md` §5): a lone prompt
 * creates no Outcome and no chain (2); settlement is never progress (4); a running
 * stage is immutable, so configuring it appends a copy instead (7).
 */

import type { ConversationSource } from './conversation-source'
import type { SessionActionPresetId } from './session-action-presets'
import type { SessionChainStageShape } from './session-chain-types'
import type { WorkPlanReviewStop } from './work-plan-types'
import type { UpNextHeader } from './up-next-header'
import type { UpNextAgentIntent } from './up-next-agent-intent'
import type { HandoffArtifactReview } from './handoff-artifact-review'
export { upNextIsFinished, upNextIsStoppedHeader, upNextIsStoppedStage } from './up-next-header'
export type {
  UpNextAttention,
  UpNextDisposition,
  UpNextHeader,
  UpNextHeaderState
} from './up-next-header'

/**
 * What an Up next call is about. A CONVERSATION is named by its address — workspace, pane
 * and the door its own messages go through — which is what the prompt queue and
 * `SessionChain.sourceRowKey` already agree on. Two surfaces carry work before any
 * conversation exists: an unstarted inbox handoff thread, and a board card. They are named
 * by their own identity, compose exactly the same blocks, and resolve to a real pane once
 * the conversation is started by the surface's own launch door.
 *
 * Round-trips: `upNext.list({ conversationId })` accepts exactly what
 * `UpNextView.conversationId` hands back.
 */
export type UpNextConversationId = ConversationSource | UpNextThreadSubject | UpNextCardSubject

/** An inbox handoff thread that has not been started yet. */
export type UpNextThreadSubject = { kind: 'thread'; threadId: string }

/** A board card the composer is looking at. */
export type UpNextCardSubject = { kind: 'card'; taskId: string }

/** True for the only subjects that can hold a running agent and a prompt queue. */
export function isUpNextConversation(subject: UpNextConversationId): subject is ConversationSource {
  return subject.kind === 'pty' || subject.kind === 'structured'
}

/** Where a new block goes: the next thing the current agent hears, or the end of the chain. */
export type UpNextAppendPosition = 'head' | 'end'

export type UpNextBlockKind = 'prompt' | 'agent' | 'person' | 'done'

/**
 * `draft` is the only state the person authored: a block held in the composer that the
 * engine has not committed yet. Every other state is a runtime reading.
 *
 * A stage the track stopped at says WHY by class, never one "blocked": `recovering` (the host
 * acts again by itself), `waiting` (a registered wake), `needs-you` (an open request to the
 * owner) or `failed` (an honest operational failure; also a prompt that could not be delivered).
 */
export type UpNextBlockState =
  | 'draft'
  | 'queued'
  | 'running'
  | 'done'
  | 'waiting'
  | 'recovering'
  | 'needs-you'
  | 'failed'

type UpNextBlockBase = {
  id: string
  kind: UpNextBlockKind
  state: UpNextBlockState
  /** "2" for a block, "2.1" for a prompt nested under block 2. */
  number: string
  /** The block a prompt is nested under; absent on top-level blocks. */
  parentId?: string
  /** Running, stopped and finished work is read-only: configure a stage after it. */
  locked: boolean
  /**
   * The host is holding this block until a gate opens. Today that gate is a person REVIEW:
   * the block was queued with it and runs in the same run once every named reviewer has
   * approved — nobody has to press anything again. It stays the person's to move or remove
   * until it launches.
   */
  heldFor?: { kind: 'review'; blockId: string }
}

/**
 * Who a prompt goes to. `current` is the conversation's own agent (the Now row);
 * `stage` is the agent stage it runs inside; `resume-after-review` is the current agent
 * when it picks the work back up after a person review returns it.
 */
export type UpNextPromptTarget =
  | { kind: 'current' }
  | { kind: 'stage'; blockId: string }
  | { kind: 'resume-after-review'; blockId: string }

/** Now = into the running agent; after = wait for the current work to finish. */
export type UpNextPromptWhen = 'now' | 'after'

export type UpNextPromptBlock = UpNextBlockBase & {
  kind: 'prompt'
  text: string
  target: UpNextPromptTarget
  /** Only meaningful for a prompt to the current agent; absent on a stage prompt. */
  when?: UpNextPromptWhen
  /** The prompt-queue entry this block is; absent while it is a draft or a stage prompt. */
  queueEntryId?: string
  /** Why a `failed` queued prompt was not delivered. */
  failureReason?: string
  /** The queue is paused behind this failed prompt; only hosts that can re-queue it set this. */
  holdsQueue?: true
}

/**
 * The topology and convergence of ONE stage, in the words the composer offers. The engine
 * owns the vocabulary (`SessionChainStageShape`): the shape a person chose is stamped on
 * every seat it compiles to, so one stage stays one block after it is committed.
 */
export type UpNextAgentShape = SessionChainStageShape

/** The role on the one worker primitive; `custom` is the person's own instruction. */
export type UpNextAgentTemplate = SessionActionPresetId | 'custom'

/** What the stage hands on: a result, findings, a pass/fail verdict, or a winner. */
export type UpNextAgentOutput = 'result' | 'findings' | 'verdict' | 'winner'

export type UpNextAgentSeat = {
  id: string
  /**
   * `queued` is a seat with a `retryable` attempt: the engine relaunches it itself, so it is
   * neither running nor failed — the same word the stage aggregate and the plan report use.
   */
  state: 'queued' | 'running' | 'done' | 'failed'
  /** One line of what this seat decided, when it emitted a verdict. */
  verdict?: string
}

/** Facts about a stage that has started; every field is measured, never estimated. */
export type UpNextAgentProgress = {
  startedAt?: number
  elapsedMs?: number
  seats?: UpNextAgentSeat[]
  durationMs?: number
  verdictSummary?: string
  /** Where the receipt for this stage lives, for the "receipt" link. */
  receiptRef?: string
  /** The raw diagnostic of a stop. It belongs under Details and never decides the state. */
  blockedReason?: string
  /** The machine code of the block or failure behind a stop. */
  stopCode?: string
  /** When the track stopped at this stage; only a stopped stage carries it. */
  stoppedAt?: number
}

/** Never rendered by default: per-seat actor, rounds, inputs, end-on-success. */
export type UpNextAgentAdvanced = {
  model?: string
  effort?: string
  rounds?: number
  stopWhen?: WorkPlanReviewStop
  /** Block ids whose results this stage reads; absent means every earlier stage. */
  readsFrom?: string[]
  endOnSuccess?: boolean
}

export type UpNextAgentBlock = UpNextBlockBase & {
  kind: 'agent'
  /** The compiled step this stage is; absent while it is a draft. */
  stepId?: string
  template: UpNextAgentTemplate
  shape: UpNextAgentShape
  n: number
  instruction: string
  output: UpNextAgentOutput
  /** Review (inspects, reports) or handoff (acts): `upNextAgentIntent(template)`, never authored. */
  intent: UpNextAgentIntent
  advanced: UpNextAgentAdvanced
  progress?: UpNextAgentProgress
  /** How many prompts are nested under this stage. */
  promptCount: number
}

/**
 * Null until the person ticks or unticks "Wait for their OK", which reads as its default until
 * then (`up-next-person-send.ts`). A handoff moves ownership and ends the track; a review
 * returns feedback and the track continues (`WP-5a §19` dispositions).
 */
export type UpNextPersonRelationship = null | 'handoff' | 'review'

export type UpNextPerson = {
  id: string
  name: string
  initials: string
  photoUrl?: string
}

/** What the people receive. A handoff is not a task: the card is opt-in. */
export type UpNextPersonReceive = {
  files: boolean
  transcript: boolean
  note?: string
  createTaskCard: boolean
  attachTaskId?: string
  /** When the handoff or review is due: ISO with offset, no fractional seconds; absent = none. */
  dueAt?: string
  /**
   * An omnios page they are asked to decide on. Each person is made a named reviewer before the
   * request leaves, reads "Review: <title>", and decides on the page; the decision comes back
   * into the thread (`handoff-artifact-review.ts`).
   */
  artifact?: HandoffArtifactReview
}

/**
 * Where a person review stands, read off the record (`up-next-person-facts.ts`): who answered this
 * round and how, how many said OK, every "needs changes" with its note, and whether the agent is
 * fixing the work right now.
 */
export type UpNextPersonBlock = UpNextBlockBase & {
  kind: 'person'
  stepId?: string
  relationship: UpNextPersonRelationship
  people: UpNextPerson[]
  receive: UpNextPersonReceive
  /** The engine's own wait rule for a review, stated rather than offered as a toggle. */
  waitRule?: 'all' | 'any'
  /** Where the track continues once a review returns. */
  resumesAtBlockId?: string
  waiting?: UpNextReviewWaiting
  /** When the last of its people was sent it, read off the delivery receipts; absent until then. */
  sentAt?: number
  /**
   * A send that did not go out, from the host's own recovery reading: `recovering` while the host
   * resends it by itself, `failed` once only Try again can. Only the status line reads it, so the
   * block keeps its own state — a send that failed before it was captured stays removable.
   */
  sendFailure?: 'recovering' | 'failed'
  /** Who a send that did not go out already reached, by employee id; absent when nobody got it. */
  reachedIds?: string[]
}

export type UpNextDoneBlock = UpNextBlockBase & {
  kind: 'done'
  /** Close ends the tab (default); Save files the session in a folder. */
  finish: 'close' | 'save'
  folderId?: string
  /** When a window reported the session closed — never when the run merely finished. */
  closedAt?: number
  /** When a window reported the session saved to its folder. */
  savedAt?: number
}

export type UpNextBlock = UpNextPromptBlock | UpNextAgentBlock | UpNextPersonBlock | UpNextDoneBlock

/**
 * The pinned, read-only first row. A running or stopped stage IS the Now row
 * (`kind: 'stage'`); a conversation whose own agent is working is `current-work`.
 */
export type UpNextNow =
  | {
      kind: 'current-work'
      /** The agent id when the host can name it, else empty: never a guess. */
      agent: string
      /** What it is doing when the host knows; empty when only "working" is known. */
      label: string
      elapsedMs?: number
    }
  | { kind: 'stage'; blockId: string }
  | {
      kind: 'idle'
      /** The agent waiting on the person, when the host can name it. Never a guess. */
      agent?: string
    }
  /** The run is proven and its session is still there: nothing was closed. */
  | { kind: 'completed'; at: number }
  | { kind: 'closed'; at: number }

/** Where the queued work starts, in the clause the summary line reads out. */
export type UpNextSummaryStart = 'now' | 'after-current-work' | 'after-stage' | 'now-interrupts'

export type UpNextSummary = {
  stages: number
  executions: number
  perStage: {
    number: string
    template: UpNextAgentTemplate
    executions: number
  }[]
  prompts: number
  people: number
  maxConcurrency: number
  maxConcurrencyStage?: string
  start: UpNextSummaryStart
  /** The stage number the queue waits on, when `start` is `after-stage`. */
  afterStage?: string
  live?: {
    stageN: number
    stageOf: number
    template: UpNextAgentTemplate
    seatsDone: number
    seatsTotal: number
    elapsedMs: number
  }
  finished?: {
    stages: number
    executions: number
    durationMs: number
    doneWhenMet: number
    doneWhenTotal: number
  }
}

/**
 * Which blocks may still be added, and WHY not. The reasons are message keys the
 * renderer localizes (`UP_NEXT_REASON_KEYS`), never English from the engine.
 */
export type UpNextCanAdd = {
  prompt: boolean
  agent: boolean
  person: boolean
  done: boolean
  reasons: Partial<Record<UpNextBlockKind, string>>
}

export type UpNextView = {
  conversationId: UpNextConversationId
  /** The sidebar row key of this conversation; the same string the chain carries. */
  rowKey: string
  header: UpNextHeader
  now: UpNextNow
  blocks: UpNextBlock[]
  notation: string
  summary: UpNextSummary
  canAdd: UpNextCanAdd
  draftCount: number
  queuedCount: number
  /**
   * Whether a send composed here carries the conversation: false where this host cannot read it
   * (an SSH, WSL or remote pane), so the files and the summary go without it. Absent when no send
   * is being composed, or the conversation is not started yet.
   */
  sendsConversation?: boolean
  /** Host-confirmed turn completion, with no queued work or unresolved outcome remaining. */
  finishReady?: boolean
  /** Whole-commitment proof from this host; absent on older hosts or unfinished work. */
  archiveProof?: string
  /** Positive pending-work evidence for restoring a prior archive; unknown is never true. */
  archiveHasWork?: boolean
  /**
   * No plan, a finished turn, and nothing queued, held, proposed, kept going or awaited by
   * another session: the host's half of the "idle, nothing pending" Done archive. Absent on
   * older hosts, which never qualify.
   */
  idleArchiveClear?: boolean
  /**
   * Nothing in flight (a finished turn, or an agent at its own prompt) and nothing queued, held,
   * proposed, kept going, awaited or left in a plan: archiving may put this conversation's agent
   * to sleep. Absent on older hosts, which keep every agent running.
   */
  archiveSleepClear?: boolean
}

/** A new block, carrying only the fields a person can author. */
export type UpNextPromptDraft = {
  kind: 'prompt'
  text: string
  when?: UpNextPromptWhen
  /** Target a specific stage; absent lets the order decide (the nearest stage above). */
  targetBlockId?: string
}

export type UpNextAgentDraft = {
  kind: 'agent'
  template: UpNextAgentTemplate
  shape?: UpNextAgentShape
  n?: number
  instruction?: string
  advanced?: UpNextAgentAdvanced
}

export type UpNextPersonDraft = {
  kind: 'person'
  relationship?: 'handoff' | 'review'
  /**
   * Who it goes to, by employee id AND the name the picker showed. The name travels with
   * the request (the hub addresses people by id), exactly as the existing handoff path does,
   * so the host never has to guess a roster it cannot read.
   */
  people?: UpNextDraftPerson[]
  /** Ids alone; `people` is preferred, because the request carries the name. */
  peopleIds?: string[]
  receive?: Partial<UpNextPersonReceive>
}

export type UpNextDraftPerson = { id: string; name: string }

/**
 * A write that the host could not carry out, in one sentence the renderer can show when it
 * has nothing more specific. Kept as the composer's generic failure text; the refusal keys
 * above are what a caller should branch on.
 */
export const UP_NEXT_WRITE_UNAVAILABLE = 'That change to Up next could not be made on this host.'

export type UpNextDoneDraft = {
  kind: 'done'
  finish?: 'close' | 'save'
  folderId?: string
}

export type UpNextDraftInput =
  | UpNextPromptDraft
  | UpNextAgentDraft
  | UpNextPersonDraft
  | UpNextDoneDraft

/** An edit to one block: the same fields, all optional, with its kind to refuse a mismatch. */
export type UpNextBlockPatch =
  | ({ kind: 'prompt' } & Partial<Omit<UpNextPromptDraft, 'kind'>>)
  | ({ kind: 'agent' } & Partial<Omit<UpNextAgentDraft, 'kind'>>)
  | ({ kind: 'person' } & Partial<Omit<UpNextPersonDraft, 'kind'>>)
  | ({ kind: 'done' } & Partial<Omit<UpNextDoneDraft, 'kind'>>)

export const UP_NEXT_RPC = {
  list: 'upNext.list',
  append: 'upNext.append',
  update: 'upNext.update',
  reorder: 'upNext.reorder',
  remove: 'upNext.remove',
  commit: 'upNext.commit',
  discardDrafts: 'upNext.discardDrafts',
  configureAfter: 'upNext.configureAfter',
  requeue: 'upNext.requeue'
} as const

export type UpNextRpcMethod = (typeof UP_NEXT_RPC)[keyof typeof UP_NEXT_RPC]

export const UP_NEXT_MAX_BLOCKS = 40
export const UP_NEXT_MAX_SEATS_PER_STAGE = 9
export const UP_NEXT_MAX_PEOPLE = 20

/**
 * Block ids are addresses, so a write names WHAT it is changing: a prompt-queue entry,
 * a plan node, a compiled step, or an uncommitted draft.
 */
export const UP_NEXT_BLOCK_ID = {
  promptQueue: 'pq:',
  planNode: 'node:',
  step: 'step:',
  /** `sp:<stepId>:<promptId>` — a prompt held by one stage's seat. */
  stagePrompt: 'sp:',
  draft: 'draft:'
} as const

/** There is at most one Done block on a conversation. */
export const UP_NEXT_DONE_BLOCK_ID = 'done'

/**
 * The stage id a commit mints for one composed Agent block (`up-next-plan-edit.ts`). It is
 * derived from the DRAFT's id and from nothing else, which is what lets a read tell a block
 * the plan already carries from one still waiting to be queued — the same question a commit
 * whose second write never landed leaves behind.
 */
export function upNextDraftStageId(draftId: string): string {
  return `stage-${draftId}`
}

/**
 * The key everything about one subject is filed under. For a conversation it IS the sidebar
 * row key (`conversationSourceRowKey`), which is the same string the chain and the prompt
 * queue use; a thread and a card get their own namespace, so nothing can collide.
 */
export function upNextRowKey(subject: UpNextConversationId): string {
  if (subject.kind === 'thread') {
    return JSON.stringify(['thread', subject.threadId])
  }
  if (subject.kind === 'card') {
    return JSON.stringify(['card', subject.taskId])
  }
  return JSON.stringify(['local', subject.worktreeId, subject.paneKey])
}

// Why an add is off or a write refused: keys the renderer words (`up-next-refusal-keys.ts`).
export { UP_NEXT_REASON_KEYS, UP_NEXT_REFUSAL_KEYS } from './up-next-refusal-keys'

// The order and summary rules live beside this file and import it, never the other way
// round: `up-next-order.ts` (`upNextTargetOf`, `upNextNumber`, `upNextIsEndCap`,
// `upNextCanAdd`) and `up-next-summary.ts` (`upNextNotation`, `upNextSummary`,
// `upNextStageExecutions`). Re-exporting them here would make the module graph cyclic.
