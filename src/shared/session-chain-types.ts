import type { SessionPrepRoutingReceipt } from './session-prep-types'
import type {
  SessionReviewAssignment,
  SessionReviewRepairAssignment,
  SessionReviewLoopState
} from './session-chain-review'
import type { SessionOutcomeSet } from './session-outcome-types'
import type { SessionChainTeamPlanning } from './next-outcome-team-plan-schema'

export type { SessionChainTeamPlanning } from './next-outcome-team-plan-schema'
import type { ExecutionHostId } from './execution-host'
import type { SessionActionPresetId } from './session-action-presets'
import type { SessionEffortParity } from './session-effort-parity'
import type { TuiAgent } from './tui-agent'
import type { SessionChainHandoffStep } from './session-follow-up-rule'
import type { PromptQueueEntry } from './prompt-queue-types'

export type { SessionChainHandoffStep } from './session-follow-up-rule'
// Reading a chain back from disk lives next door; every existing importer still finds it here.
export {
  SESSION_CHAIN_SCHEMA_VERSION,
  isQuarantinedSessionChain,
  normalizeSessionChain,
  normalizeSessionChainRound,
  normalizeSessionChainStep,
  normalizeSessionChains,
  normalizeSessionChainsWithReport
} from './session-chain-normalize'
export type { SessionChainLoadReport, SessionChainUnloadable } from './session-chain-normalize'

/**
 * A session chain: an ordered list of successors queued after one live session in a
 * workspace. The chain is personal, per Mac, and lives in the main state file beside
 * automations; it is not a hub concept. A handoff step's delivery is the hub's own
 * task-file handoff request, sent once the session it waits on has finished.
 */
/**
 * `failed` is terminal for one step: its agent died (a quota wall, an expired sign-in) or its
 * dispatch stalled past its own recorded readiness timeout. Why it exists: a step whose agent
 * died stayed `queued` forever, so the plan read as "still to come" while nothing was running.
 */
export type SessionChainStepStatus = 'queued' | 'launched' | 'skipped' | 'failed'

/** Rounds of one action: the same step repeated; `index` counts from 1 for the person. */
export type SessionChainRound = { key: string; index: number; total: number }

/** A planned seat in an outcome team: the reviewed writer, another implementer, a reviewer, or a repair. */
export type SessionChainStepRole = 'producer' | 'worker' | 'reviewer' | 'repair'

/** One seat of a widened step: `index` counts from 1 for the person, as rounds do. */
export type SessionChainStepSeat = { index: number; total: number }

/**
 * What a verdict-emitting seat decides, and what the run does with it. `over` names the step ids the
 * verdict judges; `consumed` is how the host spends it: pick the winning candidate, gate the steps
 * after it, or only record it for the person.
 */
export type SessionChainStepVerdict = {
  kind: 'review' | 'judge' | 'verify' | 'critique'
  over: string[]
  consumed: 'select-winner' | 'gate' | 'record'
}

/**
 * One entry in a chain's plan history: version `version` replaced `supersedes`, and why. The chain is
 * the lineage of one pursuit, so every version's steps, attempts and receipts stay addressable.
 */
export type SessionChainPlanVersion = {
  version: number
  supersedes?: number
  reason?: string
  at: number
}

/** A step that only runs once a verdict landed, over the seats of another node. */
export type SessionChainStepEnabledBy = { verdict: string; seatsOf: string }

/**
 * Why a ready step has not launched: the chain's concurrency budget is full, an input it reads has
 * not landed, or a person must decide first. `ref` names the blocker (a step id, a verdict id).
 */
export type SessionChainStepWaitReason = 'capacity' | 'dependency' | 'human_decision'
export type SessionChainStepWait = {
  reason: SessionChainStepWaitReason
  since: number
  ref?: string
}

/**
 * The shape the person chose for a stage in the composer. A shape may compile to several
 * nodes (a council is answers ×N → critiques ×N → judge → winner), so every seat it mints
 * carries the same `SessionChainStepStage` — that is what lets one stage be shown, edited
 * and reported as ONE block after it was committed, instead of as its parts.
 */
export type SessionChainStageShape = 'solo' | 'parallel' | 'council' | 'best-of' | 'custom'

export type SessionChainStepStage = {
  /** Shared by every seat and node the one shape compiled to. */
  id: string
  shape: SessionChainStageShape
  /** How many seats the person asked for; the convergence seats are not counted. */
  width: number
}

/** Where a step's work goes: its own `.omni/runs` folder, or the shared worktree. */
export type SessionChainStepWrites = 'own-output-dir' | 'workspace'

/** How a step is executed: a new session, the producer's own session, or a person. */
export type SessionChainStepRoute = 'new-session' | 'human' | 'same-session'

/**
 * One consumed verdict, kept on the chain so a replay cannot spend it twice and so a step that was
 * completed or skipped without a receipt is visible. `verdict` is the parsed envelope as it was read.
 */
export type SessionChainVerdictReceipt = {
  stepId: string
  attemptId: string
  verdict: unknown
  consumptionKey: string
  consumedAt: number
  /** The seat was closed without running: the receipt records the skip instead of a decision. */
  skipped?: true
}

/** Why this build refused a chain record on disk. */
export type SessionChainUnloadableReason = 'invalid-step' | 'invalid-outcome-set' | 'newer-schema'

/**
 * A record this build could not read, kept verbatim so a later save cannot delete work an older or
 * newer OmniConsole wrote. The chain it sits on is inert: no steps, no outcomes, never resumed.
 */
export type SessionChainQuarantine = {
  reason: SessionChainUnloadableReason
  detail: string
  /** The refused record exactly as it was read. A build that can read it again unwraps it on load. */
  record: unknown
}

export type SessionChainAgentStep = {
  outcomeId?: string
  /** Derived from the plan's shape at compile; display only, never part of a step's identity. */
  role?: SessionChainStepRole
  /** Stable identity of the editable step that produced this compiled runtime step. */
  editorStepId?: string
  replacedStepId?: string
  review?: SessionReviewAssignment
  reviewRepair?: SessionReviewRepairAssignment
  /** Absent on disk: agent steps predate step kinds and stay byte-compatible. */
  kind?: 'agent'
  id: string
  agent: TuiAgent
  /** Instruction typed for this step; with a preset it fills {{objective}}. */
  prompt: string
  presetId?: SessionActionPresetId
  model?: string
  openrouterCandidates?: string[]
  effort?: string
  /**
   * What this step asked for beside what its launch actually carried, written when the
   * step launches. Why on the step: effort was only ever kept as a request, so a step
   * that launched without it — or with a level the model does not advertise — read
   * exactly like one that got what it asked for.
   */
  effortParity?: SessionEffortParity
  /** Choice receipt only; the worker outcome separately attests the served model. */
  routing?: SessionPrepRoutingReceipt
  accountChoiceId?: string | null
  /**
   * Steps sharing a group launch together after the same source (a fan-out); the step
   * after the group waits on every pane the group launched. Absent means one at a time.
   */
  group?: string
  round?: SessionChainRound
  /**
   * Which seat of its group this step is, for the person: "2 of 3". Display and ordering only;
   * the group is what the runtime launches together.
   */
  seat?: SessionChainStepSeat
  /** This step emits a verdict over `over`, spent the way `consumed` says. */
  verdict?: SessionChainStepVerdict
  /**
   * The step ids whose results this step reads. Absent means every earlier completed step of the
   * outcome, which is what the host has always done.
   */
  readsFrom?: string[]
  /** Read only the winning candidate of that node, as a `select-winner` verdict chose it. */
  readsWinnerOf?: string
  /** This step is held until that verdict lands over the seats of that node. */
  enabledBy?: SessionChainStepEnabledBy
  /** Set while the step is ready but not launched, so "queued" is honest about why. */
  wait?: SessionChainStepWait
  /** The authored plan node this compiled seat came from; stable across a recompile. */
  planNodeId?: string
  /** The composer stage this seat belongs to, when a shape minted it. */
  stage?: SessionChainStepStage
  /**
   * Prompts the person added to THIS stage, in order. They are delivered into the seat's
   * own conversation once it is idle — the same door the prompt queue uses — and carry the
   * same receipts, so a restart can tell "already sent" from "never sent".
   */
  prompts?: PromptQueueEntry[]
  /** Which plan version minted this seat. Absent means 1; a superseded seat keeps its own. */
  planVersion?: number
  supersededBy?: number
  route?: SessionChainStepRoute
  writes?: SessionChainStepWrites
  status: SessionChainStepStatus
  /** Durable tab receipt written before its pane mounts, so a resumed chain never launches twice. */
  launchedTabId?: string
  /** Pane key of the session this step launched; the next step waits on it. */
  launchedPaneKey?: string | null
  launchedAt?: number
  /** The hub thread that shows this step in the owner's Waiting For; see `session-chain-hub-step`. */
  hubThreadId?: string
  /** When that thread was resolved or replied to, so a restart does not write it twice. */
  hubSettledAt?: number
}

/** A step either launches an agent session or hands the finished session's files to people. */
export type SessionChainStep = SessionChainAgentStep | SessionChainHandoffStep

export type SessionChainState =
  /** Waiting for the current source session to go idle or exit. */
  | 'waiting'
  /** The source finished after a restart and the chain is not automatic: needs a click. */
  | 'ready'
  | 'launching'
  | 'done'
  | 'cancelled'
  | 'failed'

/** What stopped a plan from moving on: a pane asking the person, or one they interrupted. */
export type SessionChainBlock = { paneKey: string; reason: string }

export type SessionChain = {
  outcomeSet?: SessionOutcomeSet
  /**
   * Version of this record's shape. Absent means 1; this build writes
   * `SESSION_CHAIN_SCHEMA_VERSION` on a chain that carries a field that version introduced.
   */
  schemaVersion?: number
  /** Verdict receipts spent by the host, in the order they were consumed. */
  verdicts?: SessionChainVerdictReceipt[]
  /** The plan version this chain is pursuing now. Absent means 1. */
  planVersion?: number
  /** Every version this chain has pursued, oldest first; the lineage of one outcome. */
  planVersions?: SessionChainPlanVersion[]
  /** Present only on a record this build refused to read; the chain carries no work. */
  quarantine?: SessionChainQuarantine
  /** Set only by the host when a source agent commits a team under the user's launch consent. */
  teamPlanning?: SessionChainTeamPlanning
  /**
   * Outcomes a person committed, which may run beside other work of this chain up to the
   * concurrency setting. Written only by the outcome commit; absent means one at a time.
   */
  parallelOutcomeIds?: string[]
  reviewLoop?: SessionReviewLoopState
  /**
   * ✓ `done` ends the session when the work finishes successfully (a plan with no steps is
   * just that); ↩ `me` hands the finished work back as "needs you".
   */
  end?: 'me' | 'done'
  placement?: ExecutionHostId
  sourceWorktreeId?: string
  id: string
  workspacePath: string
  worktreeId: string
  hostId: string | null
  /** Pane key of the session the first step waits on. */
  sourcePaneKey: string
  /** Sidebar row key of the source session, for the queued indicator. */
  sourceRowKey: string
  /** Continue without a click after OmniConsole restarts. Off by default. */
  auto: boolean
  steps: SessionChainStep[]
  /** Index of the step that runs next. */
  currentIndex: number
  state: SessionChainState
  error?: string | null
  /** Set while a pane the plan waits on needs the person; this device's view only, never saved. */
  blocked?: SessionChainBlock | null
  createdAt: number
  updatedAt: number
}

export const SESSION_CHAIN_OUTPUT_ROOT = '.omni/runs'

/** Output folder for one step, using the workspace's `.omni/runs` convention. */
export function sessionChainStepOutputDir(
  workspacePath: string,
  chainId: string,
  stepId: string
): string {
  const separator = workspacePath.includes('\\') && !workspacePath.includes('/') ? '\\' : '/'
  const root = workspacePath.replace(/[\\/]+$/, '')
  return [root, ...SESSION_CHAIN_OUTPUT_ROOT.split('/'), chainId, stepId].join(separator)
}

export function isLiveSessionChain(chain: SessionChain): boolean {
  return chain.state === 'waiting' || chain.state === 'ready' || chain.state === 'launching'
}

export function sessionFollowUpStep(chain: SessionChain): SessionChainHandoffStep | null {
  return (
    chain.steps.find((step): step is SessionChainHandoffStep => step.kind === 'handoff') ?? null
  )
}

export function isSessionFollowUpChain(chain: SessionChain): boolean {
  return chain.steps.some((step) => step.kind === 'handoff')
}

/** A chain that launches at least one agent session; it shows on its source row as queued. */
export function isSessionQueueChain(chain: SessionChain): boolean {
  return chain.steps.some((step) => step.kind !== 'handoff')
}

export function isSessionChainAgentStep(step: SessionChainStep): step is SessionChainAgentStep {
  return step.kind !== 'handoff'
}

/**
 * The steps whose result feeds step `index`: every member of the group just before it,
 * or the nearest earlier step outside `index`'s own group. Members of one group all
 * read the same predecessors. An empty list means the chain's source session.
 */
export function sessionChainPredecessors(
  chain: Pick<SessionChain, 'steps'>,
  index: number
): SessionChainAgentStep[] {
  const own = chain.steps[index]?.group
  let cursor = index - 1
  while (cursor >= 0) {
    const step = chain.steps[cursor]!
    if (own && step.group === own) {
      cursor -= 1
      continue
    }
    if (step.group) {
      const group = step.group
      const members = chain.steps.filter((candidate) => candidate.group === group)
      if (members.some(isSessionChainAgentStep)) {
        return members.filter(isSessionChainAgentStep)
      }
      // Why: a group of people-only steps launches nothing to wait on; look further back.
      cursor = chain.steps.indexOf(members[0]!) - 1
      continue
    }
    if (isSessionChainAgentStep(step)) {
      return [step]
    }
    cursor -= 1
  }
  return []
}
