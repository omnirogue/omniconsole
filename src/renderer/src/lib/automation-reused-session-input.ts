import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { recordRuntimeTerminalInputForPtyId } from '@/runtime/runtime-terminal-inspection'
import type { RuntimeTerminalSend } from '../../../shared/runtime-types'
import type { AutomationOutputBindingRequest } from '../../../shared/automations-types'
import { recordAutomationTerminalInput } from './terminal-input-activity-coalescing'

export async function sendAutomationSessionInput(args: {
  workspaceId: string
  paneKey: string
  ptyId: string
  text: string
  automationOutputBinding?: AutomationOutputBindingRequest
}): Promise<boolean> {
  const result = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
    { kind: 'local' },
    'automation.sendInput',
    args,
    { timeoutMs: 15_000 }
  )
  if (!result.send.accepted) {
    throw new Error('Automation input was refused by the execution host.')
  }
  // Why the second stamp: the routine's prompt is pane input for hibernation and idle
  // policies, but not a person taking over; reuse compares later input against it.
  const acceptedAt = Date.now()
  recordRuntimeTerminalInputForPtyId(args.ptyId, acceptedAt)
  recordAutomationTerminalInput(args.paneKey, acceptedAt)
  return true
}
