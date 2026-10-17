import { DISCOVER_DEFAULT_MAX_AGENTS } from '../../../../shared/local-workflow-draft'
import type { WorkflowProgramSnapshot } from '../workflow-execution-service'
import type { DiscoverV7Config } from './discover-v7-plan'

/**
 * The revision 7 planning rules admission freezes as host.discoverRules. Rules 2: a serialized
 * seat takes one finder job a round, and a finder job may report past its share into the votes
 * other jobs leave. A snapshot admitted before them has no mark and replays as it ran.
 */
export const DISCOVER_V7_RULES = 2

/**
 * The only mapping from a frozen snapshot to the revision 7 config. The preset runner and the
 * projection both call it, so the program and the live view can never pick different seats,
 * finders or finding ids.
 */
export function discoverV7ConfigFromSnapshot(snapshot: WorkflowProgramSnapshot): DiscoverV7Config {
  const discover = snapshot.discover
  const host = snapshot.host as
    | { workspaceRoot?: { path?: unknown }; serializedSeats?: unknown; discoverRules?: unknown }
    | null
    | undefined
  const root = host?.workspaceRoot?.path
  // A routing hint frozen at admission; snapshots admitted before it route as they always did.
  const serialized = Array.isArray(host?.serializedSeats)
    ? host.serializedSeats.filter((id): id is string => typeof id === 'string')
    : []
  const rules = typeof host?.discoverRules === 'number' ? host.discoverRules : 1
  return {
    seats: snapshot.seats,
    finderIds: discover?.finderIds ?? [],
    rankerId: snapshot.synthesizerId,
    lensIds: discover?.lensIds ?? [],
    depth: discover?.depth ?? 'thorough',
    focus: discover?.focus ?? [],
    maxAgents: discover?.maxAgents ?? DISCOVER_DEFAULT_MAX_AGENTS,
    access: snapshot.access === 'workspace-read' ? 'workspace-read' : 'frozen',
    ...(typeof root === 'string' && root ? { workspaceRoot: root } : {}),
    ...(serialized.length ? { serializedSeatIds: serialized } : {}),
    ...(rules < 2 ? { firstRules: true as const } : {})
  }
}
