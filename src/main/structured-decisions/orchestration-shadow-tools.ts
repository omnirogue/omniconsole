import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { normalizeHookEventName } from '../../shared/agent-hook-listener/provider-event-names'
import type { OrchestrationShadowObservation } from './orchestration-shadow'
import { shadowIdentity, shadowReference } from './orchestration-shadow-bounds'

const TOOL_EVENTS = new Set([
  'pre_tool_use',
  'post_tool_use',
  'post_tool_use_failure',
  'before_tool',
  'after_tool',
  'tool_call',
  'tool_execution_start',
  'tool_execution_end',
  'pre_tool_call',
  'post_tool_call'
])
const TOOL_KINDS: Record<string, string> = {
  read: 'read',
  read_file: 'read',
  grep: 'read',
  glob: 'read',
  search: 'read',
  write: 'write',
  write_file: 'write',
  edit: 'write',
  apply_patch: 'write',
  multiedit: 'write',
  bash: 'execute',
  shell: 'execute',
  exec_command: 'execute',
  run_command: 'execute',
  askuserquestion: 'ask',
  ask_user_question: 'ask',
  request_user_input: 'ask'
}

export function projectToolShadow(
  event: AgentHookEventPayload
): OrchestrationShadowObservation | null {
  if (!shadowIdentity(event.hookEventName) || !shadowIdentity(event.payload.toolName)) {
    return null
  }
  const reference = shadowReference(
    event.connectionId ?? 'local',
    event.paneKey,
    event.toolUseId ?? 'no-tool-id',
    event.hookEventName
  )
  if (!reference) {
    return null
  }
  const name = normalizeHookEventName(event.hookEventName)
  if (!TOOL_EVENTS.has(name)) {
    return null
  }
  const tool = event.payload.toolName.toLowerCase()
  const known = Object.hasOwn(TOOL_KINDS, tool)
  return {
    kind: 'tool_action',
    reference,
    observed: known ? TOOL_KINDS[tool]! : 'unknown',
    choices: {
      read: 'The recognized tool reads or searches existing information.',
      write: 'The recognized tool edits or creates content.',
      execute: 'The recognized tool executes a command; its effects are not established here.',
      ask: "The recognized tool asks for a person's input.",
      unknown: 'The tool is not recognized or its action cannot be established.'
    },
    facts: {
      knownTool: known ? tool : null,
      remoteExecution: event.connectionId !== null,
      providerReportedFailure: event.payload.failed === true,
      argumentsIncluded: false,
      permissionEvidenceIncluded: false
    }
  }
}
