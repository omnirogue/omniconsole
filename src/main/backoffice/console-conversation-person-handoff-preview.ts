import { isDeepStrictEqual } from 'node:util'
import type { ConsoleConversationFleetPreviewRequest } from '../../shared/console-conversation-fleet-types'
import type { ConsoleWorkflowGraph } from '../../shared/console-workflow-types'
import {
  PERSON_HANDOFF_HANDLER_KEY,
  PERSON_HANDOFF_HANDLER_DIGEST
} from '../../shared/console-workflow-mechanical-execution'

const requestedFields = [
  'version',
  'approved',
  'recipient_employee_id',
  'task_id',
  'action',
  'note',
  'include_summary',
  'deliverables',
  'due_at'
] as const

export function matchesConversationPersonHandoffs(
  input: ConsoleConversationFleetPreviewRequest,
  graph: ConsoleWorkflowGraph,
  clerkUserId: string | undefined
): boolean {
  return graph.nodes.every((node) => {
    const expected = input.classification.steps.find(
      (step) => step.key === node.key
    )?.person_handoff
    const actual = node.person_handoff
    if (!expected) {
      return actual === undefined && node.mechanical_execution === undefined
    }
    if (!actual || !clerkUserId) {
      return false
    }
    return (
      isDeepStrictEqual(node.mechanical_execution, {
        handler_key: PERSON_HANDOFF_HANDLER_KEY,
        handler_digest: PERSON_HANDOFF_HANDLER_DIGEST,
        input: { person_handoff: actual }
      }) &&
      requestedFields.every((field) => isDeepStrictEqual(expected[field], actual[field])) &&
      actual.participants.director.employee_id === graph.owner &&
      actual.participants.director.clerk_user_id === clerkUserId &&
      actual.participants.recipient.employee_id === expected.recipient_employee_id &&
      isDeepStrictEqual(actual.source_files, expected.source_files ?? []) &&
      isDeepStrictEqual(actual.summary_file, expected.summary_file) &&
      actual.source_files.every((file) =>
        (input.sourceFiles ?? []).some((source) => isDeepStrictEqual(file, source))
      ) &&
      (actual.summary_file === undefined ||
        (expected.include_summary &&
          isDeepStrictEqual(actual.summary_file, input.sourceSummaryFile)))
    )
  })
}
