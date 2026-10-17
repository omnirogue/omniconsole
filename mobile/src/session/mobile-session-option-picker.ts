// How mobile answers a session option the desktop answers with a relaunch.

import type {
  CatalogCommandDelivery,
  CatalogMidSessionApply
} from '../../../src/shared/agent-session-option-catalog'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat-session-options'

/** Mobile has no in-pane relaunch: the desktop answers a `resume-relaunch`
 *  option by restarting the agent under the pane and resuming the same thread,
 *  which needs a PTY this surface does not own. Here the agent's own picker is
 *  the honest path, so both `agent-picker` and a `resume-relaunch` that names a
 *  picker command are typed into the terminal and hand the session over. */
export function mobilePickerCommand(
  midSession: CatalogMidSessionApply | undefined
): { command: string; delivery?: CatalogCommandDelivery } | null {
  if (midSession?.kind === 'agent-picker') {
    return midSession.delivery
      ? { command: midSession.command, delivery: midSession.delivery }
      : { command: midSession.command }
  }
  if (midSession?.kind === 'resume-relaunch' && midSession.pickerCommand) {
    // Typed, never pasted: the agent's picker reads the line the person sees.
    return { command: midSession.pickerCommand, delivery: 'type' }
  }
  return null
}

/** Re-tag a `resume-relaunch` row as the picker action mobile actually performs. */
export function withMobilePickerActions(
  snapshot: SessionOptionDescriptor[]
): SessionOptionDescriptor[] {
  return snapshot.map((descriptor) =>
    descriptor.applyKind === 'resume-relaunch' && descriptor.action === undefined
      ? { ...descriptor, action: { type: 'agent-picker' as const } }
      : descriptor
  )
}
