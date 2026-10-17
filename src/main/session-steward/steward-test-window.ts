/** The desktop window as the steward's tests see it: archives file the row, deletes remove it. */

import { vi } from 'vitest'
import type { SessionFolderRelayRequest } from '../../shared/session-folder-cli'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { OrganizationRelayedOutcome } from '../../shared/session-organization-change'
import type { StewardStopWatch } from './steward-actions'

/**
 * `stop.outcome` is what the closed pane's process reports: `stopped` when its provider or host
 * confirmed the exit, `unconfirmed` for a failed kill or a lost connection.
 */
export function fakeStewardWindow(sessions: Map<string, { row: SessionManageSidebarRow }>) {
  const stop = { outcome: 'stopped' as 'stopped' | 'unconfirmed' | 'no-process' }
  const stopWatch: StewardStopWatch = () => async () => stop.outcome
  const relay = vi.fn(async (request: SessionFolderRelayRequest): Promise<unknown> => {
    if (request.kind === 'mutate' && request.op.kind === 'deleteSession') {
      // Why: the sidebar's Delete, as `omni session delete` relays it; its tab closes.
      const paneKey = request.op.paneKey!
      const session = sessions.get(paneKey)!
      sessions.delete(paneKey)
      const organization: OrganizationRelayedOutcome = {
        opId: request.change!.opId,
        targets: [{ sessionKey: session.row.viewKey, paneKey }],
        value: true,
        before: [false],
        after: [true]
      }
      return {
        summary: `Deleted “${session.row.title}” Its tab closed; reopen it from Recently closed.`,
        sessionKey: session.row.viewKey,
        tabClose: 'closed',
        organization
      }
    }
    if (request.kind !== 'applyOrganizationChange') {
      throw new Error(`unexpected ${request.kind}`)
    }
    const paneKey = request.change.targets[0]?.paneKey
    const session = [...sessions.values()].find((entry) => entry.row.paneKey === paneKey)!
    session.row = { ...session.row, archived: true }
    return {
      opId: request.change.opId,
      targets: [{ sessionKey: session.row.viewKey, paneKey }],
      value: true,
      before: [false],
      after: [true]
    } satisfies OrganizationRelayedOutcome
  })
  return Object.assign(relay, { stop, stopWatch })
}
