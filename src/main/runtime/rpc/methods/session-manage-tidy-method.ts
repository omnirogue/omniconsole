// `sessionManage.tidy` — `omni session tidy`: a plan over every sidebar conversation, and on
// `apply` the plan's archive rows, each re-checked and archived through `sessionFolders.mutate`.
// A steward run (an automatic cleanup session) gets the Tier 2 rule instead of the on-request one.

import type { SessionManageSidebarRow } from '../../../../shared/session-manage-relay'
import { sessionManageHostKey } from '../../../../shared/session-manage-query'
import {
  SESSION_MANAGE_RPC,
  type SessionTidyResult,
  type SessionTidyRow
} from '../../../../shared/session-manage-types'
import { assertSessionManageCaller } from '../../../session-manage/session-manage-caller'
import {
  describeMissingTarget,
  findSessionManageRow,
  observeSessionManageRows,
  toSessionManageEntry
} from '../../../session-manage/session-manage-inventory'
import { observeSession } from '../../../session-manage/session-manage-observe'
import { readSidebarRows } from '../../../session-manage/session-manage-runtime-actions'
import { createRuntimeObserveSources } from '../../../session-manage/session-manage-runtime-sources'
import { withRuntimeWorkflowRuns } from '../../../session-manage/session-manage-workflow-runtime'
import {
  backgroundTidyKey,
  backgroundTidyRows
} from '../../../session-manage/session-manage-background-terminals'
import { createBackgroundTidyApply } from './session-manage-tidy-background'
import { unattendedContextFor } from '../../../session-manage/session-manage-unattended'
import { unattendedTidyPlan } from '../../../session-manage/session-manage-unattended-admission'
import {
  applySessionTidy,
  classifySessionTidyFor,
  planSessionTidy,
  sessionTidyHoldReason,
  type SessionTidyMode
} from '../../../session-manage/session-manage-tidy'
import { answerWaitKeeper } from '../../../answer-delivery/answer-wait'
import { defineMethod, type RpcContext } from '../core'
import { mutateSessionFolders } from './session-folders'
import { SessionManageTidyParams } from './session-manage-schemas'
import { actorFor } from './session-manage-support'

export const SESSION_TIDY_APPLY_NEEDS_REQUEST =
  'session tidy --apply needs --request "<the person\'s own words>": archiving runs only when the person asks for it. Nothing changed.'

export const SESSION_TIDY_UNATTENDED_INCLUDE =
  'A steward run cannot archive held sessions: only the person can name them with --include. Nothing changed.'

export const SESSION_TIDY_UNATTENDED_DELETE =
  'A steward run cannot delete sessions: only the person can ask for session tidy --delete. Nothing changed.'

export const SESSION_TIDY_UNVERIFIED_NEEDS_DELETE =
  '--unverified goes with --delete: archive never acts on a session this computer cannot verify. Nothing changed.'

const AUDIT_REASON_MAX = 1000

function auditReason(row: SessionTidyRow, reason: string | undefined): string {
  const why = `session tidy: ${row.reason}`
  return (reason ? `${reason} — ${why}` : why).slice(0, AUDIT_REASON_MAX)
}

/** Background terminals join the plan: kept with their reason, ended only when named in delete. */
function withBackgroundRows<
  T extends { rows: SessionTidyRow[]; counts: { skip: number; delete?: number } }
>(plan: T, background: SessionTidyRow[]): T {
  if (!background.length) {
    return plan
  }
  const count = (action: SessionTidyRow['action']): number =>
    background.filter((row) => row.action === action).length
  return {
    ...plan,
    rows: [...plan.rows, ...background],
    counts: {
      ...plan.counts,
      skip: plan.counts.skip + count('skip'),
      ...(plan.counts.delete !== undefined ? { delete: plan.counts.delete + count('delete') } : {})
    }
  }
}

function holdFor(context: RpcContext) {
  return (row: Pick<SessionManageSidebarRow, 'rowKey' | 'paneKey' | 'worktreeId'>) =>
    sessionTidyHoldReason(context.runtime.listSessionChains(), row)
}

export const SESSION_MANAGE_TIDY_METHOD = defineMethod({
  name: SESSION_MANAGE_RPC.tidy,
  params: SessionManageTidyParams,
  handler: async (params, context): Promise<SessionTidyResult> => {
    assertSessionManageCaller(context)
    // Why no rows yet: whether a person is behind it rests on the caller, not on any title.
    const unattended = unattendedContextFor(actorFor(context, []))
    if (params.apply && !params.request && !unattended) {
      throw new Error(SESSION_TIDY_APPLY_NEEDS_REQUEST)
    }
    if (unattended && params.include?.length) {
      throw new Error(SESSION_TIDY_UNATTENDED_INCLUDE)
    }
    if (unattended && params.delete) {
      throw new Error(SESSION_TIDY_UNATTENDED_DELETE)
    }
    if (params.unverified && !params.delete) {
      throw new Error(SESSION_TIDY_UNVERIFIED_NEEDS_DELETE)
    }
    const rows = await readSidebarRows(context.runtime)
    const actor = actorFor(context, rows)
    // Why an unproven pane too: keeping a row is always safe, deleting the caller never is.
    const self =
      actor.kind === 'pane' ? actor.paneKey : actor.kind === 'cli' ? actor.unverifiedPaneKey : null
    const selfTab = self ? rows.find((row) => row.paneKey === self)?.tabId : undefined
    // Why read once: plan and every recheck keep what waits on the person's answer.
    const answerWait = answerWaitKeeper(context.runtime.getArtifactApiOrigin())
    const mode: SessionTidyMode = params.delete
      ? {
          delete: true,
          ...(params.unverified ? { unverified: true } : {}),
          ...(self ? { selfPaneKey: self } : {}),
          ...(selfTab ? { selfTabId: selfTab } : {}),
          answerWait
        }
      : { answerWait }
    const scoped = rows.filter(
      (row) =>
        !row.folded &&
        (params.hostId === undefined || sessionManageHostKey(row.hostId) === params.hostId)
    )
    const include = new Set(params.include ?? [])
    const background = context.runtime.listBackgroundRuntimeOwnedTerminals()
    for (const key of include) {
      // Why tabs too in delete mode: a row with no pane yet is named by its tab; a workflow
      // conversation (never a pane) is named by its tab in either mode.
      const found = scoped.some(
        (row) =>
          row.paneKey === key ||
          ((mode.delete || row.workflow) && !row.paneKey && row.tabId === key)
      )
      if (!found && !background?.some((terminal) => backgroundTidyKey(terminal) === key)) {
        throw new Error(describeMissingTarget({ paneKey: key }))
      }
    }
    const backgroundOptions = {
      include,
      delete: mode.delete === true,
      answerWait,
      ...(self ? { selfPaneKey: self } : {}),
      ...(selfTab ? { selfTabId: selfTab } : {})
    }
    // Why the controller reader: a workflow's run is revalidated where it is recorded (C6).
    const sources = withRuntimeWorkflowRuns(
      createRuntimeObserveSources(context.runtime),
      context.runtime
    )
    const backgroundRows = await backgroundTidyRows(
      background,
      rows,
      sources,
      params.hostId,
      backgroundOptions
    )
    const backgroundApply = createBackgroundTidyApply(
      context,
      background,
      backgroundRows,
      backgroundOptions
    )
    const planned = withBackgroundRows(
      planSessionTidy(
        await observeSessionManageRows(scoped, sources),
        holdFor(context),
        include,
        mode
      ),
      backgroundRows
    )
    const plan = unattended ? await unattendedTidyPlan(planned, unattended) : planned
    if (!params.apply) {
      return { dryRun: true, actor, ...plan }
    }
    const { rows: outcome, applied } = await applySessionTidy(plan.rows, {
      recheck: async (target) => {
        if (backgroundApply.owns(target)) {
          return backgroundApply.recheck(target)
        }
        const row = findSessionManageRow(
          await readSidebarRows(context.runtime),
          {
            ...(target.paneKey ? { paneKey: target.paneKey } : {}),
            ...(target.tabId ? { tabId: target.tabId } : {}),
            ...(target.workflow ? { workflow: target.workflow } : {})
          },
          { tabOnly: mode.delete === true }
        )
        if (!row) {
          return null
        }
        const entry = toSessionManageEntry(await observeSession(row, sources))
        return classifySessionTidyFor(mode, row, entry, holdFor(context)(row), include)
      },
      archive: (target) =>
        mutateSessionFolders(context, {
          op: {
            kind: 'archiveSession',
            ...(target.paneKey ? { paneKey: target.paneKey } : {}),
            ...(target.tabId ? { tabId: target.tabId } : {}),
            ...(target.workflow ? { workflow: target.workflow } : {}),
            archived: true
          },
          reason: auditReason(target, params.reason),
          ...(params.request ? { request: params.request } : {})
        }),
      ...(mode.delete
        ? {
            delete: (target: SessionTidyRow) =>
              backgroundApply.owns(target)
                ? backgroundApply.end(target, actor, {
                    reason: auditReason(target, params.reason),
                    ...(params.request ? { request: params.request } : {})
                  })
                : mutateSessionFolders(context, {
                    op: {
                      kind: 'deleteSession',
                      ...(target.paneKey ? { paneKey: target.paneKey } : {}),
                      ...(target.tabId ? { tabId: target.tabId } : {}),
                      ...(target.workflow ? { workflow: target.workflow } : {}),
                      ...(target.unverified ? { unverified: true } : {})
                    },
                    reason: auditReason(target, params.reason),
                    ...(params.request ? { request: params.request } : {})
                  })
          }
        : {})
    })
    return { dryRun: false, actor, ...plan, rows: outcome, applied }
  }
})
