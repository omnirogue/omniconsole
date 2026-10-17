import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import type { DiscoverConfig } from './presets/discover'
import type { COUNCIL_REVISION, DISCOVER_REVISION } from './workflow-program-revisions'
import type { GraphSnapshotFields } from './graph/graph-plan-types'
import type { CouncilProgramRevision } from './presets/council'
import type { AuditSnapshot } from './audit/audit-snapshot'

/** Graph runs add their frozen spec and seats (GraphSnapshotFields). */
export type WorkflowProgramSnapshot = GraphSnapshotFields & {
  version: 1
  /** Host-captured bundled audit program; clients send only its source selection. */
  audit?: AuditSnapshot
  /** Missing on older checkpoints, which always used frozen read-only analysis. */
  capability?: { mode: 'frozen-analysis' | 'working-agent'; revision: 1 }
  /** Pinned for host Council runs; absent host snapshots predate the prompt revision. */
  councilProgramRevision?: CouncilProgramRevision | typeof COUNCIL_REVISION
  /** Run-pinned, shuffled labels for working Council; never derived from public seat order. */
  councilBlindLabels?: string[]
  /** Unversioned Discover snapshots use the original selection and skeptical prompt. */
  discoverProgramRevision?: 1 | 2 | 3 | 4 | 5 | 6 | typeof DISCOVER_REVISION
  /** Absent: frozen evidence only (legacy). workspace-read: read-only tools in host.workspaceRoot. */
  access?: 'workspace-read'
  host?: unknown
  limits?: { concurrency: number }
  task: { prompt: string; evidence: string }
  seats: ResolvedLocalWorkflowSeat[]
  synthesizerId: string
  /** Council revision 6 roles. */
  council?: { memberIds: string[] }
  discover?: Pick<DiscoverConfig, 'dimensions' | 'lenses' | 'minimumSeverity' | 'maxCandidates'> & {
    /** Discover revision 7. */
    finderIds?: string[]
    lensIds?: string[]
    depth?: 'quick' | 'thorough' | 'exhaustive'
    focus?: string[]
    maxAgents?: number
  }
}

/** A frozen seat by id: one a step runs on, or a spare a call that failed at launch moved to. */
export function workflowFrozenSeat(
  snapshot: Pick<WorkflowProgramSnapshot, 'seats' | 'graph'>,
  seatId: string
): ResolvedLocalWorkflowSeat | undefined {
  return (
    snapshot.seats.find((seat) => seat.id === seatId) ??
    snapshot.graph?.spareSeats?.find((seat) => seat.id === seatId)
  )
}

export function requireWorkflowFrozenSeat(
  snapshot: Pick<WorkflowProgramSnapshot, 'seats' | 'graph'>,
  id: string
): ResolvedLocalWorkflowSeat {
  const seat = workflowFrozenSeat(snapshot, id)
  if (!seat) {
    throw new Error(`Missing frozen workflow seat ${id}`)
  }
  return seat
}
