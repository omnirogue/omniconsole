/**
 * Ends a runtime-owned terminal that runs in the background, not in a window, on a person's
 * explicit request (`session tidy --delete --include`, or End in the owner's sidebar). It is
 * re-checked first — still runtime-owned, still shown by no window tab, the same PTY — then ended
 * through the audited path `omni terminal close` uses. Nothing calls this on its own.
 */

import type { BackgroundRuntimeTerminal } from '../../shared/background-runtime-terminal'
import type { RuntimeTerminalClose } from '../../shared/runtime-types'
import type { RpcContext } from '../runtime/rpc/core'
import { withTerminalCloseAttribution } from '../runtime/rpc/terminal-close-attribution'

export const BACKGROUND_TERMINAL_GONE =
  'It no longer runs in the background outside a window, so nothing was ended.'

export type BackgroundEndContext = Pick<
  RpcContext,
  'runtime' | 'clientKind' | 'pairedDeviceId' | 'connectionId' | 'requestId'
>

export async function endBackgroundRuntimeTerminal(
  context: BackgroundEndContext,
  ptyId: string
): Promise<{ terminal: BackgroundRuntimeTerminal; closed: RuntimeTerminalClose }> {
  const terminal = context.runtime
    .listBackgroundRuntimeOwnedTerminals()
    ?.find((candidate) => candidate.ptyId === ptyId)
  if (!terminal) {
    throw new Error(BACKGROUND_TERMINAL_GONE)
  }
  const closed = await withTerminalCloseAttribution(
    'terminal.close',
    context,
    'terminal',
    terminal.handle,
    () => context.runtime.closeTerminal(terminal.handle)
  )
  return { terminal, closed }
}

export function backgroundEndSummary(title: string): string {
  return `Ended “${title}”, which ran in the background, not in a window.`
}
