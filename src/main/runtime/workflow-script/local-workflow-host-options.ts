import type Database from '../../sqlite/sync-database'
import type { OrcaRuntimeService } from '../omni-runtime'
import type { OrchestrationDb } from '../orchestration/db'
import type { AgentSessionProcessIdentity } from '../../../shared/agent-session-record'
import type { LocalWorkflowScopeOption } from '../../../shared/local-workflow-draft'
import type {
  LocalWorkflowSeatCatalog,
  ResolvedLocalWorkflowSeat
} from '../../../shared/local-workflow-seats'
import type { LocalWorkflowSeatCapacity } from '../../../shared/local-workflow-seat-capacity'
import type {
  WorkflowPlacement,
  WorkflowPlacementPick,
  WorkflowRunsOn
} from '../../../shared/local-workflow-placement'
import type {
  LocalWorkflowChangedEvent,
  LocalWorkflowSetupRequest,
  LocalWorkflowShowRequest
} from '../../../shared/local-workflow-rpc'
import type { LocalWorkflowSource, LocalWorkflowView } from '../../../shared/local-workflow-view'
import type { WorkflowScriptSlots } from './workflow-script-slots'
import type { WorkflowAttemptLaunch } from './workflow-durable-call'
import type { WorkflowLiveObserver } from './workflow-live-observer'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import type { WorkflowNativeAttestationInput } from './workflow-execution-service'
import type { AgentBudgetClient } from './agent-budget-client'

/** `executionHost`: set only once the runtime proved the run executes on this computer. */
export type LocalWorkflowWorkspace = {
  id: string
  path: string
  label: string
  executionHost?: 'local'
}
export type LocalWorkflowFrozenScope = {
  evidence: string
  sources: LocalWorkflowSource[]
  coverage: string[]
}
export type LocalWorkflowHostOptions = {
  db: Database.Database
  owner: AgentSessionProcessIdentity
  slots: WorkflowScriptSlots
  resolve: (
    request: LocalWorkflowSetupRequest | LocalWorkflowShowRequest
  ) => Promise<LocalWorkflowWorkspace>
  catalog: () => Promise<LocalWorkflowSeatCatalog[]>
  /** Freshens account usage readings before setup picks default seats; bounded by the host. */
  refreshCapacity?: () => Promise<void>
  /** Each seat's account capacity now, freshened first: where a call that failed at launch moves. */
  seatCapacity?: () => Promise<(seat: ResolvedLocalWorkflowSeat) => LocalWorkflowSeatCapacity>
  listScope: (workspace: LocalWorkflowWorkspace) => Promise<LocalWorkflowScopeOption[]>
  freezeScope: (
    workspace: LocalWorkflowWorkspace,
    ids: string[]
  ) => Promise<LocalWorkflowFrozenScope>
  /**
   * Where a new Start runs (absent `runsOn` reads as fleet): the placement frozen into its
   * snapshot, or a throw naming why no fleet host takes it. A host without it places every run here.
   */
  place?: (
    runsOn: WorkflowRunsOn | undefined,
    pick?: WorkflowPlacementPick,
    excludedMachines?: readonly string[]
  ) => Promise<WorkflowPlacement>
  /**
   * Readies a `dispatched-seats` host for the run before it is admitted (signed-in CLIs, the
   * copy of what agents read) and returns the placement with its `dispatch`, or throws by name.
   * A host without it refuses dispatched runs.
   */
  dispatch?: (
    placement: WorkflowPlacement,
    snapshot: LocalWorkflowHostSnapshot
  ) => Promise<WorkflowPlacement>
  discardDispatch?: (placement: WorkflowPlacement) => Promise<void>
  preflight?: (snapshot: LocalWorkflowHostSnapshot) => Promise<void>
  /**
   * The shared agent budget authority, present only while this computer enforces budgets: every
   * Start then names an approved root and every call is admitted against it before it runs.
   */
  budgetAuthority?: AgentBudgetClient
  launch: (
    snapshot: LocalWorkflowHostSnapshot,
    executionId: string,
    fence: number,
    observer: WorkflowLiveObserver
  ) => WorkflowAttemptLaunch
  attestNativeResult: (input: WorkflowNativeAttestationInput) => void
  /** Throttled window broadcast so hidden tabs and sidebar rows stay current. */
  notify?: (event: LocalWorkflowChangedEvent) => void
  /**
   * Told when a run this app was running settles, with its state and a reader of its full view
   * (Discover to OmniOS). Reopening a run that settled earlier never tells it.
   */
  onSettled?: (executionId: string, state: string, view: () => Promise<LocalWorkflowView>) => void
  /** Writable orchestration workers for working-agent runs; a host without them refuses those. */
  working?: { db: OrchestrationDb; runtime: OrcaRuntimeService }
}
