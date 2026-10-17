import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ORCHESTRATION_RESULT_SUBMIT_SPEC: CommandSpec = {
  path: ['orchestration', 'result-submit'],
  summary: 'Validate and record a structured result for a workflow Dispatch',
  usage:
    'omni orchestration result-submit --dispatch <id> --file <json_path> --dispatch-capability <token> [--from <handle>] [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'file', 'dispatch-capability', 'from'],
  notes: [
    'Run this from the assigned worker terminal before worker_done. Schema errors leave the same Dispatch active for correction.',
    'The file is read by this CLI and sent to the runtime for validation; it is never parsed from terminal prose.'
  ]
}
