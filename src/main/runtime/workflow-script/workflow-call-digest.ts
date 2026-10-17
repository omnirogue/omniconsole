import { workflowEvidenceDigest } from './workflow-evidence-digest'
import type { WorkflowProgramCall } from './workflow-program-context'

export function workflowCallDigest(call: WorkflowProgramCall, seat: string, route: string): string {
  if (!seat) {
    throw new Error('Resolved workflow seat identity required')
  }
  return workflowEvidenceDigest(
    JSON.stringify({
      callId: call.id,
      prompt: call.prompt,
      schema: call.schema,
      dependencies: call.dependencies,
      seat,
      route,
      // Absent for legacy calls so their persisted digests stay identical.
      ...(call.output ? { output: call.output } : {})
    })
  )
}
