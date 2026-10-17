/**
 * The real sources behind re-titling and merge suggestions: what a session is pursuing now, a title
 * change recorded as `app/steward` (origin `generated`, revision-bound), the files two sessions
 * both changed, and the consolidation a Yes in Work runs as the accepting person.
 */

import type { OrcaRuntimeService } from '../../runtime/omni-runtime'
import type { RpcContext } from '../../runtime/rpc/core'
import { prepareSessionTarget } from '../../runtime/rpc/methods/session-manage-support'
import { auditActor } from '../../session-manage/session-actions-log'
import { findSessionConflicts } from '../../session-manage/session-manage-conflicts'
import { handoffSession } from '../../session-manage/session-manage-handoff'
import { runtimeReadChangedFiles } from '../../session-manage/session-manage-runtime-actions'
import { runtimeTransferDeps } from '../../session-manage/session-manage-transfer-runtime'
import { sessionOrganizationLedgerFor } from '../../session-organization/organization-change-ledger'
import { recordTitleRename } from '../../session-organization/organization-title-rename'
import type { SessionManageRenameReply } from '../../../shared/session-manage-relay'
import type { StewardConsolidate, StewardMergeDeps } from './steward-merge-suggest'
import { STEWARD_ORGANIZE_ACTOR } from './steward-refile'
import type { StewardRetitleDeps } from './steward-retitle'
import { readStewardTitleReading } from './steward-title-reading'
import { getSessionSearchService } from '../../session-search/session-search-service'

export function runtimeStewardRetitleMergeDeps(
  runtime: OrcaRuntimeService,
  userDataPath: string
): StewardRetitleDeps & StewardMergeDeps {
  return {
    summaryTitles: async (rows) => {
      const sources = rows.flatMap(({ row }) => {
        const session = row.paneKey
          ? runtime.getLastAgentHookRowForPane(row.paneKey)?.providerSession
          : null
        return session?.id && (row.agent === 'claude' || row.agent === 'codex')
          ? [{ key: row.viewKey, sessionKey: `${row.agent}:${session.id}` }]
          : []
      })
      const titles = await getSessionSearchService()?.summaryTitles([
        ...new Set(sources.map((source) => source.sessionKey))
      ])
      return new Map(
        sources.flatMap(({ key, sessionKey }) => {
          const title = titles?.[sessionKey]
          return title ? [[key, title] as const] : []
        })
      )
    },
    titleReading: (observed) => readStewardTitleReading(runtime, observed.row),
    retitle: async (observed, title, change) => {
      const { row } = observed
      const applied = await recordTitleRename(
        sessionOrganizationLedgerFor(userDataPath),
        {
          row,
          title,
          executor: { kind: 'app', feature: 'steward' },
          origin: 'generated',
          actor: auditActor(STEWARD_ORGANIZE_ACTOR),
          ...change
        },
        (relayed) =>
          runtime.requestSessionFolders({
            kind: 'renameSession',
            ...(row.paneKey ? { paneKey: row.paneKey } : {}),
            ...(row.tabId ? { tabId: row.tabId } : {}),
            title,
            change: relayed
          }) as Promise<SessionManageRenameReply>
      )
      return applied.opId
    },
    sharedFiles: async (left, right) => {
      const result = await findSessionConflicts([left, right], runtimeReadChangedFiles(runtime))
      return result.repos.flatMap((repo) => repo.sharedFiles.map((file) => file.path))
    }
  }
}

/**
 * Merges one session into another in-process as the accepting person (the suggestion actor): a
 * handoff into an existing target, which briefs it, waits for its acknowledgement, lets it adopt
 * what waited on the source, and only then archives the source.
 */
export function runtimeStewardConsolidate(runtime: OrcaRuntimeService): StewardConsolidate {
  return async ({ actor, request, source, target }) => {
    const context: RpcContext = { runtime }
    const reason = 'the steward suggested merging them'
    const from = await prepareSessionTarget(runtime, { paneKey: source.row.paneKey! })
    const into = await prepareSessionTarget(runtime, { paneKey: target.row.paneKey! })
    const result = await handoffSession(runtimeTransferDeps(context, actor, { reason, request }), {
      actor,
      sources: [from],
      target: into,
      dryRun: false
    })
    return { completed: result.outcome === 'completed', summary: result.summary }
  }
}
