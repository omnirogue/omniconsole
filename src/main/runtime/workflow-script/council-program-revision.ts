import type { WorkflowProgramSnapshot } from './workflow-execution-service'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { workflowCallDigest } from './workflow-call-digest'
import { createWorkflowProgramContext, type WorkflowProgramCall } from './workflow-program-context'
import { runCouncilProgram, type CouncilProgramRevision } from './presets/council'
import { COUNCIL_REVISION } from './workflow-program-revisions'

const revisions: CouncilProgramRevision[] = [1, 2, 3, 4]

export { COUNCIL_REVISION }

/** Existing calls must agree with the pinned or inferred program before admission. */
export async function resolveCouncilProgramRevision(
  store: WorkflowCheckpointStore,
  executionId: string,
  fence: number,
  snapshot: WorkflowProgramSnapshot
): Promise<CouncilProgramRevision | typeof COUNCIL_REVISION> {
  const pinned = snapshot.councilProgramRevision
  if (pinned === COUNCIL_REVISION) {
    // Revision 6 is always pinned at admission; its call ids never overlap revisions 1-5.
    return COUNCIL_REVISION
  }
  if (pinned !== undefined && !revisions.includes(pinned)) {
    throw new Error('Unsupported Council program revision')
  }
  const evidence = store.readCallEvidence(executionId, fence)
  if (!evidence.length) {
    if (pinned !== undefined) {
      return pinned
    }
    if ('host' in snapshot) {
      throw new Error('Unversioned Council has no call evidence to identify its program')
    }
    return 4
  }
  const saved = new Map(evidence.map((row) => [row.callId, row]))
  const matches: CouncilProgramRevision[] = []
  for (const revision of pinned === undefined ? revisions : [pinned]) {
    const calls: WorkflowProgramCall[] = []
    const context = createWorkflowProgramContext({
      agent: async (call) => {
        calls.push(call)
        const accepted = saved.get(call.id)?.result
        if (accepted !== undefined && accepted !== null) {
          return accepted
        }
        if (call.id.startsWith('answers/')) {
          return { markdown: 'unaccepted', sources: [], uncertainties: [] }
        }
        if (call.id.startsWith('peer/')) {
          const labels = snapshot.seats
            .filter((seat) => seat.id !== call.seatId)
            .map((seat) => `Response ${String.fromCharCode(65 + snapshot.seats.indexOf(seat))}`)
          return {
            ranking: labels,
            assessments: labels.map((label) => ({ label, strengths: '', weaknesses: '' }))
          }
        }
        return { markdown: 'unaccepted', sources: [], disagreements: [] }
      },
      guard: () => {},
      isFatal: () => false,
      phase: () => {},
      log: () => {}
    })
    try {
      await runCouncilProgram(
        context,
        { panel: snapshot.seats, synthesizerId: snapshot.synthesizerId, revision },
        snapshot.task
      )
    } catch {
      // Cached ballot validation may fail after its recorded call identity was built.
    }
    if (
      evidence.every((row) => {
        const call = calls.find((candidate) => candidate.id === row.callId)
        const seat = call && snapshot.seats.find((candidate) => candidate.id === call.seatId)
        return (
          call &&
          seat &&
          workflowCallDigest(call, JSON.stringify(seat), seat.agent) === row.inputDigest
        )
      })
    ) {
      matches.push(revision)
    }
  }
  if (pinned !== undefined && matches.length !== 1) {
    throw new Error('Pinned Council revision conflicts with persisted call evidence')
  }
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? 'Unversioned Council program is ambiguous; recovery requires its original source'
        : 'Unsupported or corrupt unversioned Council call evidence'
    )
  }
  return matches[0]
}
