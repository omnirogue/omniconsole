import type { ConsoleWorkflowJson } from './console-workflow-types'

export type ConsoleWorkflowMechanicalExecution = {
  handler_key: string
  handler_digest: string
  input: Record<string, ConsoleWorkflowJson>
}

export const PERSON_HANDOFF_HANDLER_KEY = 'canonical.control.person-handoff-receipt.v1'
export const PERSON_HANDOFF_HANDLER_DIGEST =
  'ffcd2efd4425d816aa5d29ec31940736552bc3c5d685cc4ba4128b60b35398de'
