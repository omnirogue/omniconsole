/**
 * `restart` of an exited session with no window: R2's own resume, which starts the same provider
 * conversation in a new tab from main. The held-row path is skipped, since it asks the window to
 * reopen its tab, and the row the window last listed says whether the person hid it.
 */

import type { SessionManageResumeReply } from '../../shared/session-manage-relay'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { SessionManageRefusal } from '../session-manage/session-manage-refusal'
import { resumeConversation } from '../session-manage/session-manage-resume'
import { runtimeResumeDeps } from '../session-manage/session-manage-resume-runtime'
import type { HostSessionInventory } from './host-session-inventory'

export function headlessSessionResume(
  runtime: Parameters<typeof runtimeResumeDeps>[0] & Pick<OrcaRuntimeService, 'ensureAgentSession'>,
  inventory: HostSessionInventory,
  userDataPath: string
): (target: { paneKey?: string; tabId?: string }) => Promise<SessionManageResumeReply> {
  return async (target) => {
    const { rows } = await inventory.rows()
    const row = rows.find((candidate) =>
      target.paneKey ? candidate.paneKey === target.paneKey : candidate.tabId === target.tabId
    )
    if (!row?.providerSessionId) {
      throw new SessionManageRefusal(
        'This computer has no record of which conversation that pane ran, so it cannot resume it with no window open. Nothing changed.'
      )
    }
    const resumed = await resumeConversation(
      {
        ...runtimeResumeDeps(runtime, { userDataPath }),
        readRows: async () => [],
        organization: async () => ({
          deleted: false,
          hidden: row.hidden === true,
          archiveKind: row.archiveKind ?? null
        })
      },
      { actor: { kind: 'cli' }, ref: `${row.agent}:${row.providerSessionId}@local`, dryRun: false }
    )
    return { summary: resumed.summary, tabId: resumed.tabId ?? null }
  }
}
