import type { DiscoverRunSource, DiscoverOmniosFinding } from '../../../shared/discover-omnios-page'
import type { ContractRef } from '../../../shared/decision-contracts/decision-contract-types'
import type { WorkflowProgramSnapshot } from './workflow-execution-service'
import type { LocalWorkflowSource } from '../../../shared/local-workflow-view'
import type { WorkflowCheckpointStart } from './workflow-checkpoint-admission'
import type { WorkflowContextRecordEntry } from '../../../shared/workflow-context-layout'
import type { WorkflowPlacement } from '../../../shared/local-workflow-placement'
import type { WorkflowEarlierFindings } from './workflow-earlier-findings'

export type LocalWorkflowHostSnapshot = WorkflowProgramSnapshot & {
  host: {
    workspaceId: string
    conversationId: string
    requestDigest: string
    startedAt: number
    concurrency: number
    sources: LocalWorkflowSource[]
    coverage: string[]
    /**
     * Where the run was placed at admission (docs/reference/workflow-fleet-placement.md). Absent
     * on runs admitted before placement was a choice, which ran, and replay, on this computer.
     */
    placement?: WorkflowPlacement
    /** Who asked an agent to start this run, and their words; absent when a person started it. */
    requestedBy?: string
    requestedById?: string
    request?: string
    /**
     * Started without the cross-run known list (a benchmark rep or --no-earlier-runs): its
     * results are not brought to OmniOS either. Absent on every other run.
     */
    isolated?: true
    discoverSource?: DiscoverRunSource
    focusedFinding?: DiscoverOmniosFinding
    focusFinding?: string
    workingSource?: { sourceBase: string; sourceDiffDigest: string }
    output?: { root: string; fileName: string; device: string; inode: string }
    /** Frozen identity of the workspace agents may read when access is workspace-read. */
    workspaceRoot?: { path: string; device: string; inode: string }
    /**
     * Present when agents read a private context folder (workspaceRoot) instead of the workspace:
     * each top-level folder in it and where it came from. Absent on every other run.
     */
    context?: { entries: WorkflowContextRecordEntry[] }
    /** Find the best: the workspace its results files are saved in (agents never read it). */
    resultsRoot?: { path: string; device: string; inode: string }
    /**
     * Find the best: the planning rules the run was admitted under (FIND_RULES). Absent on runs
     * admitted before rules 2, which replay as they ran.
     */
    findRules?: number
    /** Frozen opt-in for stopping Improve after consecutive unresolved rounds. */
    improveUnresolvedRounds?: true
    /** The Improve rules the run was admitted under (IMPROVE_RULES); absent before rules 2. */
    improveRules?: number
    /** The decision rules the run was admitted under (DECISION_RULES); absent before rules 1. */
    decisionRules?: number
    /** Each JEV decision point's contract (resolveDecisionContracts); absent before rules 1. */
    contracts?: Record<string, ContractRef>
    /** Improve, a change to the code: the clean commit every private copy starts from. */
    checkSource?: { sourceBase: string }
    /** The web rules (WEB_RULES) of a run whose spec reads pages; every other run has none. */
    webRules?: number
    /**
     * Discover revision 7: seats whose account took calls one at a time when the run was admitted
     * (a Codex login due to refresh). A routing hint only: votes avoid them when they can.
     */
    serializedSeats?: string[]
    /**
     * Discover revision 7: the planning rules the run was admitted under (DISCOVER_V7_RULES).
     * Absent on runs admitted before rules 2, which replay as they ran.
     */
    discoverRules?: number
    /**
     * The evidence rules (EVIDENCE_RULES) of a run whose finders quote code: rules 2 check each
     * result's citations and absence searches before review. Absent: quotes only.
     */
    evidenceRules?: number
    /**
     * The cross-run known list frozen at admission (workflow-earlier-findings.ts). Absent when
     * nothing earlier matched, the run opted out, or it was admitted before the list existed.
     */
    earlierFindings?: WorkflowEarlierFindings
  }
}

export type LocalWorkflowWorkingStart = WorkflowCheckpointStart & {
  snapshot: LocalWorkflowHostSnapshot
  workspaceId?: string
  sourceBase?: string
  sourceDiffDigest?: string
}
