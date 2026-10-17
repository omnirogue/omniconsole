import { z } from 'zod'
import {
  sessionPrepConnectorSchema,
  sessionPrepConnectorTextSchema
} from './session-prep-connector'
import type { TuiAgent } from './tui-agent'

/**
 * Session prep ("Reverse Prompting"): a person asks, in any conversation, for new sessions; the host
 * plans the items, prepares an execution prompt for each, checks it, repairs it, and launches it.
 * The request is the person's own composer submission, so the host is the only launcher and no
 * agent ever commits a prepared prompt (the outcome-commit quote rule is untouched).
 */

export const SESSION_PREP_RPC = {
  request: 'sessionPrep.request',
  get: 'sessionPrep.get',
  listForSource: 'sessionPrep.listForSource',
  cancel: 'sessionPrep.cancel',
  confirm: 'sessionPrep.confirm',
  decideReuse: 'sessionPrep.decideReuse'
} as const

/** One request prepares at most this many sessions (the plan is a bounded list). */
export const SESSION_PREP_MAX_ITEMS = 30
/** More planned items than this wait for the person's one-click confirmation before launching. */
export const SESSION_PREP_BIG_BATCH = 12
/** Conversation text the composer may attach, most recent last. */
export const SESSION_PREP_MAX_CONTEXT_CHARS = 24_000
export const SESSION_PREP_MAX_REQUEST_CHARS = 24_000
/** Items prepared at the same time. */
export const SESSION_PREP_CONCURRENCY = 10
/** Repair rounds after a failed check before the best version launches anyway. */
export const SESSION_PREP_MAX_REPAIRS = 2

export type SessionPrepItemState =
  | 'planned'
  | 'preparing'
  | 'checking'
  | 'repairing'
  /** A free related session could take it instead; waits for the person's choice. */
  | 'awaiting-reuse'
  | 'launching'
  | 'launched'
  /** Given to an existing session instead of launching one. */
  | 'assigned'
  /** Not launched: another session is already doing it, or editing its files. */
  | 'already-covered'
  | 'failed'
  | 'cancelled'

export type SessionPrepBatchState =
  | 'planning'
  | 'awaiting-confirm'
  | 'running'
  | 'done'
  | 'cancelled'
  | 'failed'

export type SessionPrepSource = {
  /** Per-intake override; omitted preserves the existing live router default. */
  routingMode?: 'off' | 'shadow' | 'live'
  /** Work home uses its dispatcher planner; Need Speed and conversations use the lighter planner. */
  entryPoint?: 'work' | 'need-speed'
  worktreeId: string
  paneKey: string
  /** The agent the source conversation runs; new sessions default to it. */
  agent: TuiAgent
}

/** Effort levels a person can name for a launched session ("high effort", "xhigh", "max effort"). */
export const SESSION_PREP_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type SessionPrepEffort = (typeof SESSION_PREP_EFFORTS)[number]
/** What the preparer may recommend when the person named no effort ('max' is theirs to ask for). */
export const SESSION_PREP_RECOMMENDED_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const

/**
 * Launch choices the person stated for an item, each found in their own words (never inferred).
 * `folder` is a Conversations sidebar folder path, outermost first ("OmniRogue / Prototypes").
 */
export type SessionPrepChoices = {
  agent?: TuiAgent
  model?: string
  effort?: SessionPrepEffort
  folder?: string
  /** Execution host explicitly named by the person; never a filesystem path. */
  host?: string
  /** Agent template id whose name the person said; wins over the batch's chosen template. */
  agentTemplate?: string
}

/** What a session launches with, as the prompt's provenance line and the status tooltip name it. */
export type SessionPrepLaunchLabel = {
  agent: TuiAgent
  model?: string
  effort?: string
}

/** What the planner returns per item. `anchor` quotes the person's own words. */
export type PlannedItem = {
  title: string
  /** A self-contained restatement of this one outcome. */
  ask: string
  anchor: string
  /** Already a complete instruction: launch the person's words, no preparation. */
  direct: boolean
  changesCode: boolean
  /** A repository the person named for this item, as they named it. */
  repoHint?: string
  /** Earlier item indexes this one must follow, only when the person stated an order. */
  after?: number[]
  /** Agent, model, effort and folder the person named for this item (or once for the batch). */
  choices?: SessionPrepChoices
}

/** The preparer's structured output; the host renders the final prompt from it. */
export type PreparedFields = {
  title: string
  outcome: string
  doneWhen: string[]
  decided: string[]
  references: { path: string; why: string }[]
  constraints: string[]
  assumptions: string[]
  /** Only for a fact or decision nobody but the person can supply. */
  blockingQuestion: { question: string; options: string[]; why: string } | null
  changesCode: boolean
  /** Recommended effort from the task's difficulty; the person's own choice always wins. */
  effort?: SessionPrepEffort
  /** The registered repository the work belongs in, when the preparer found it is not this one. */
  repo?: string
}

export type GateFailureCode =
  | 'placeholder'
  | 'structure'
  | 'missing-reference'
  | 'unrequested-risk'
  | 'contradiction'
  | 'not-ready'
  | 'needless-question'

export type GateFailure = { code: GateFailureCode; detail: string }

export type GateVerdict = {
  pass: boolean
  failures: GateFailure[]
  /** Set when the check agrees the person really must answer before the work can succeed. */
  ask: { question: string; options: string[] } | null
  /** Raw probabilities by question id, kept for the JEV learning record. */
  scores: Record<string, number>
  /** Which judge decided: JEV alone, or a stronger model where JEV was unsure or unavailable. */
  judge: 'jev' | 'model' | 'deterministic'
  /** Why JEV could not answer, when a stronger judge or the deterministic checks had to decide. */
  jevError?: string
}

/** One text generation through the person's own read-only one-shot agent CLI. */
export type PrepTextRequest = {
  cwd: string
  /** SSH execution owner; absent means local. Never inferred from a path. */
  connectionId?: string
  prompt: string
  agent: TuiAgent
  model?: string
  effort?: string
  timeoutMs: number
}
export type PrepRunText = (request: PrepTextRequest) => Promise<string>
/** JEV yes/no questions over one state; returns P(yes) per question id, or throws. */
export type PrepJevAsk = (
  state: Record<string, string>,
  questions: Record<string, string>
) => Promise<Record<string, number>>

export type PrepAgentTemplateChoice = { id: string; name: string }

export type PrepRepoChoice = {
  selector: string
  name: string
  host?: string
  hostAliases?: string[]
}

/**
 * The model-facing steps, injected into the service so plumbing and prompting stay separate.
 * `cwd` is the workspace the step reads (read-only).
 */
export type SessionPrepSteps = {
  plan(input: {
    request: string
    context: string
    source: SessionPrepSource
    cwd: string
    /** SSH execution owner; absent means local. Never inferred from a path. */
    connectionId?: string
    repos: PrepRepoChoice[]
    /** Agent templates the person may name for an item (never Default). */
    agentTemplates?: PrepAgentTemplateChoice[]
  }): Promise<{ items: PlannedItem[]; dropped: string[] }>
  prepare(input: {
    item: PlannedItem
    index: number
    siblings: PlannedItem[]
    request: string
    context: string
    cwd: string
    /** SSH execution owner; absent means local. Never inferred from a path. */
    connectionId?: string
    /** Registered local repositories the preparer may name as the right place for the work. */
    repos?: { name: string; path: string }[]
  }): Promise<PreparedFields>
  revise(input: {
    item: PlannedItem
    fields: PreparedFields
    failures: GateFailure[]
    request: string
    context: string
    cwd: string
    /** SSH execution owner; absent means local. Never inferred from a path. */
    connectionId?: string
  }): Promise<PreparedFields>
  gate(input: {
    item: PlannedItem
    fields: PreparedFields
    request: string
    context: string
    cwd: string
    /** SSH execution owner; absent means local. Never inferred from a path. */
    connectionId?: string
  }): Promise<GateVerdict>
  render(input: {
    fields: PreparedFields
    item: PlannedItem
    index: number
    request: string
    batchId: string
    ask: GateVerdict['ask']
    siblings: string[]
    unresolved: GateFailure[]
    /** Agent, model and effort the session launches with, named in the provenance line. */
    launch?: SessionPrepLaunchLabel
  }): string
  /** A direct item or failed preparation: the person's words, batch scope and provenance. */
  renderDirect(input: {
    item: PlannedItem
    index: number
    request: string
    batchId: string
    siblings?: string[]
    note?: string
    /** A question the check agreed only the person can answer; kept when the own words launch. */
    ask?: GateVerdict['ask']
    launch?: SessionPrepLaunchLabel
  }): string
}

export type SessionPrepRoutingReceipt = {
  status: 'selected' | 'shadow' | 'off' | 'unavailable' | 'pinned'
  reason: string
  tier?: string
  elapsedMs?: number
  version?: string
  /** A requested launch choice; not a claim about the model that served the result. */
  selected?: { provider: TuiAgent; model: string; effort?: string }
  modelEvidence?: 'advertised' | 'estate-policy'
}

export type SessionPrepItemView = {
  routing?: SessionPrepRoutingReceipt
  index: number
  title: string
  state: SessionPrepItemState
  direct: boolean
  repairs: number
  /** Why it launched without preparation or failed, in plain words. */
  note?: string
  launched?: { worktreeId: string; newWorkspace: boolean }
  /** The agent it launches (or launched) on. */
  agent?: TuiAgent
  model?: string
  effort?: string
  /** The Conversations folder it is (or will be) filed in. */
  folder?: string
  /** The agent template its brief carries, by display name. */
  agentTemplate?: string
  /** Execution host explicitly named by the person; never a filesystem path. */
  host?: string
  /**
   * `awaiting-reuse`: the session that could take it (`assign`), is already doing it
   * (`duplicate`) or is busy editing its files (`conflict-busy`); why ("idle, same folder"); and,
   * after a failed attempt, why that did not work. `assigned`/`already-covered`: that session.
   */
  reuse?: { kind: SessionPrepReuseKind; title: string; why: string; failed?: string }
}

export type SessionPrepReuseKind = 'assign' | 'duplicate' | 'conflict-busy'
/** `assign` (kind assign), `skip` (don't launch; duplicate or conflict-busy) or `launch` new. */
export type SessionPrepReuseChoice = 'assign' | 'launch' | 'skip'

export type SessionPrepBatchView = {
  id: string
  createdAt: number
  state: SessionPrepBatchState
  source: SessionPrepSource
  request: string
  items: SessionPrepItemView[]
  /** Why asked-for work did not become a session, or why the batch failed, in plain words. */
  notes: string[]
}

/** RPC results, one object per method so each can grow fields without breaking callers. */
export type SessionPrepRequestResult = { batchId: string }
export type SessionPrepBatchResult = { batch: SessionPrepBatchView | null }
export type SessionPrepListResult = { batches: SessionPrepBatchView[] }

const text = (max: number) => z.string().trim().min(1).max(max)

export const SESSION_PREP_PARAMS = {
  request: z
    .object({
      text: z
        .string()
        .min(1)
        .max(SESSION_PREP_MAX_REQUEST_CHARS)
        .refine((value) => !!value.trim()),
      connector: sessionPrepConnectorSchema.optional(),
      // A retry keeps this identity; older strict hosts reject it without starting work.
      requestId: text(128).optional(),
      source: z.object({
        worktreeId: text(4096),
        paneKey: text(1024),
        agent: text(64),
        entryPoint: z.enum(['work', 'need-speed']).optional(),
        routingMode: z.enum(['off', 'shadow', 'live']).optional()
      }),
      context: z.string().max(SESSION_PREP_MAX_CONTEXT_CHARS).default(''),
      // Why optional and sent only when chosen: older hosts parse this object strictly.
      agentTemplateId: text(64).optional(),
      // Why top level: `source` is not strict, so an older host would drop it there silently.
      defaultFolder: text(1000).optional()
    })
    .strict()
    .refine(
      ({ text, connector }) => !connector || sessionPrepConnectorTextSchema.safeParse(text).success,
      {
        path: ['text'],
        message: 'Connector requests must be at most 24,000 UTF-8 bytes.'
      }
    ),
  get: z.object({ batchId: text(64) }).strict(),
  listForSource: z.object({ paneKey: text(1024) }).strict(),
  cancel: z.object({ batchId: text(64) }).strict(),
  confirm: z.object({ batchId: text(64) }).strict(),
  decideReuse: z
    .object({
      batchId: text(64),
      index: z.number().int().min(0).max(SESSION_PREP_MAX_ITEMS),
      choice: z.enum(['assign', 'launch', 'skip'])
    })
    .strict()
} as const
