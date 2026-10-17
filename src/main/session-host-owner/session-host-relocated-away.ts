/**
 * A conversation this host relinquished to another computer (package C's relocation) is that
 * computer's now: nothing here restarts, resumes or delivers to it again, whatever its old pane or
 * transcript still shows. Read from the account registry this process has open.
 */

import { activeRuntimeSessionHost } from '../session-host/session-host-runtime'
import { relocatedAwayIn } from './session-host-relocated-journal'

/** Why this provider conversation may not run here again; null when nothing says so. */
export function relocatedAwayRefusal(
  provider: { agent: string; sessionId: string | null | undefined } | null
): string | null {
  if (!provider?.sessionId) {
    return null
  }
  const journal = activeRuntimeSessionHost()?.current()?.store.snapshot()
  const away = relocatedAwayIn(journal, { agent: provider.agent, sessionId: provider.sessionId })
  return away
    ? `This conversation was moved to ${away.toHostId} and runs there now, so it is not started again on this computer. Nothing changed.`
    : null
}
