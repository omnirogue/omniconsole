// `sessionOrganization.*` — the record of every organization change (session-organization/).
// Only the desktop window prepares and settles its own changes (CLI changes are recorded by
// `sessionFolders.mutate`); history, recent and undoPlan also answer the local CLI.

import { randomUUID } from 'node:crypto'
import type { SessionFolderProbeReply } from '../../../../shared/session-folder-cli'
import { SESSION_ORGANIZATION_RPC } from '../../../../shared/session-organization-change'
import {
  ARCHIVE_SLEEP_REASONS,
  ArchiveSleepNoteParamsSchema,
  ArchiveSleepReadingParamsSchema
} from '../../../../shared/archive-sleep-contract'
import {
  OrganizationHistoryParamsSchema,
  OrganizationPrepareParamsSchema,
  OrganizationRecentParamsSchema,
  OrganizationSettleParamsSchema,
  OrganizationUndoPlanParamsSchema
} from '../../../../shared/session-organization-change-schema'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import { sessionOrganizationLedgerFor } from '../../../session-organization/organization-change-ledger'
import { reconcileInterruptedChanges } from '../../../session-organization/organization-reconciliation'
import { readSessionActions } from '../../../session-organization/organization-actions-reader'
import {
  readMergedHistory,
  undoableOpIds
} from '../../../session-organization/organization-session-history'
import {
  OrganizationActionsParamsSchema,
  SESSION_ORGANIZATION_ACTIONS_RPC,
  type OrganizationActionsResult,
  type OrganizationSessionHistory
} from '../../../../shared/session-organization-readers'
import { sessionActionsLogFor } from '../../../session-manage/session-actions-log'
import {
  describeMissingTarget,
  findSessionManageRow
} from '../../../session-manage/session-manage-inventory'
import { readSidebarRows } from '../../../session-manage/session-manage-runtime-actions'
import { readArchiveSleepHost } from '../../archive-sleep-host-reading'
import { runtimeArchiveSleepHostDeps } from '../../archive-sleep-host-runtime'
import type { z } from 'zod'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'

export const SESSION_ORGANIZATION_WINDOW_ONLY_ERROR =
  'Only the OmniConsole window on this computer records its own organization changes.'
export const SESSION_ORGANIZATION_LOCAL_ONLY_ERROR =
  'Only the OmniConsole window and omni CLI on this computer can read the session history.'

const DEFAULT_RECENT_MS = 24 * 60 * 60 * 1000
const DEFAULT_RECENT_LIMIT = 200
const DEFAULT_ACTIONS_LIMIT = 500

function isDesktopWindow(context: RpcContext): boolean {
  return (
    context.clientId === 'desktop-renderer' &&
    context.clientKind === 'runtime' &&
    context.connectionId?.startsWith('desktop-renderer:') === true &&
    !context.pairedDeviceId &&
    !context.orchestrationCapability &&
    !context.orchestrationCompatibilityEvidence
  )
}

export function assertOrganizationWindowCaller(context: RpcContext): void {
  if (!isDesktopWindow(context)) {
    throw new Error(SESSION_ORGANIZATION_WINDOW_ONLY_ERROR)
  }
}

/** The window, or the local socket (no paired device or remote client identity). */
export function assertOrganizationLocalReader(context: RpcContext): void {
  if (
    !isDesktopWindow(context) &&
    (context.pairedDeviceId || context.clientId || context.clientKind)
  ) {
    throw new Error(SESSION_ORGANIZATION_LOCAL_ONLY_ERROR)
  }
}

function ledger() {
  return sessionOrganizationLedgerFor(getProfileUserDataPath())
}

/** A bare key reads as is; a pane or tab reads its sidebar row's key plus its pre-resolution keys. */
async function readSessionHistory(
  context: RpcContext,
  params: z.infer<typeof OrganizationHistoryParamsSchema>
): Promise<OrganizationSessionHistory> {
  let keys: string[]
  let row: OrganizationSessionHistory['row']
  if (params.key) {
    keys = [params.key, ...(params.aliases ?? [])]
  } else {
    const target = params.target ?? {}
    const found = findSessionManageRow(await readSidebarRows(context.runtime), target)
    if (!found) {
      throw new Error(describeMissingTarget(target))
    }
    row = {
      viewKey: found.viewKey,
      title: found.title,
      paneKey: found.paneKey,
      tabId: found.tabId
    }
    keys = [
      found.viewKey,
      ...(found.paneKey ? [`pane:${found.paneKey}`] : []),
      ...(found.tabId ? [`tab:${found.tabId}`] : [])
    ]
  }
  const history = await readMergedHistory(ledger(), keys)
  return {
    ...history,
    undoable: await undoableOpIds(ledger(), history.entries),
    ...(row ? { row } : {})
  }
}

export const SESSION_ORGANIZATION_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_ORGANIZATION_RPC.prepare,
    params: OrganizationPrepareParamsSchema,
    handler: async (params, context) => {
      assertOrganizationWindowCaller(context)
      const record = await ledger().prepare(params.change, {
        ...(params.before ? { before: params.before } : {}),
        ...(params.summary ? { audit: { summary: params.summary } } : {})
      })
      return { opId: record.opId, ts: record.ts }
    }
  }),
  defineMethod({
    name: SESSION_ORGANIZATION_RPC.settle,
    params: OrganizationSettleParamsSchema,
    handler: async (params, context) => {
      assertOrganizationWindowCaller(context)
      const settled = await ledger().settle({
        phase: params.phase,
        change: params.change,
        ...(params.before ? { before: params.before } : {}),
        ...(params.after ? { after: params.after } : {}),
        ...(params.error ? { error: params.error } : {}),
        ...(params.summary ? { audit: { summary: params.summary } } : {})
      })
      return {
        ...(settled.revision ? { revision: settled.revision } : {}),
        ...(settled.auditError ? { auditError: settled.auditError } : {})
      }
    }
  }),
  defineMethod({
    name: SESSION_ORGANIZATION_RPC.history,
    params: OrganizationHistoryParamsSchema,
    handler: async (params, context) => {
      assertOrganizationLocalReader(context)
      return readSessionHistory(context, params)
    }
  }),
  defineMethod({
    name: SESSION_ORGANIZATION_RPC.recent,
    params: OrganizationRecentParamsSchema,
    handler: async (params, context) => {
      assertOrganizationLocalReader(context)
      const entries = await ledger().recent({
        since: params.since ?? Date.now() - DEFAULT_RECENT_MS,
        ...(params.executors ? { executors: params.executors } : {}),
        ...(params.kinds ? { kinds: params.kinds } : {}),
        limit: params.limit ?? DEFAULT_RECENT_LIMIT
      })
      return { entries, undoable: await undoableOpIds(ledger(), entries) }
    }
  }),
  defineMethod({
    name: SESSION_ORGANIZATION_ACTIONS_RPC,
    params: OrganizationActionsParamsSchema,
    handler: async (params, context): Promise<OrganizationActionsResult> => {
      assertOrganizationLocalReader(context)
      await ledger().flush()
      return {
        actions: await readSessionActions(sessionActionsLogFor(getProfileUserDataPath()).path, {
          since: params.since ?? Date.now() - DEFAULT_RECENT_MS,
          ...(params.actors ? { actors: params.actors } : {}),
          ...(params.kinds ? { kinds: params.kinds } : {}),
          limit: params.limit ?? DEFAULT_ACTIONS_LIMIT
        })
      }
    }
  }),
  defineMethod({
    name: SESSION_ORGANIZATION_RPC.undoPlan,
    params: OrganizationUndoPlanParamsSchema,
    handler: async (params, context) => {
      assertOrganizationLocalReader(context)
      return ledger().undoPlan(params.opId)
    }
  }),
  defineMethod({
    name: SESSION_ORGANIZATION_RPC.noteArchiveSleep,
    params: ArchiveSleepNoteParamsSchema,
    // Why the ledger: History and `omni session history` read only its records, so the pause
    // shows beside the archive that caused it (the trail line still carries the audit words).
    handler: async (params, context) => {
      assertOrganizationWindowCaller(context)
      const title = params.title.trim() || params.sessionKey
      const { auditError } = await ledger().note(
        {
          opId: randomUUID(),
          kind: 'sleep',
          targets: [
            { sessionKey: params.sessionKey, paneKey: params.paneKey, tabId: params.tabId }
          ],
          value: true,
          executor: { kind: 'app', feature: 'archive-sleep' },
          reason: ARCHIVE_SLEEP_REASONS[params.trigger],
          evidence: params.evidence
        },
        {
          target: { paneKey: params.paneKey, tabId: params.tabId, title },
          before: { state: 'done', via: params.via, trigger: params.trigger },
          after: { sleeping: true, restoreOnTabOpenOnly: true, sessionKey: params.sessionKey },
          summary: `Archive paused the agent in "${title}"; opening it resumes the conversation.`
        }
      )
      return auditError ? { auditError } : {}
    }
  }),
  defineMethod({
    name: SESSION_ORGANIZATION_RPC.archiveSleepReading,
    params: ArchiveSleepReadingParamsSchema,
    handler: async (params, context) => {
      assertOrganizationWindowCaller(context)
      return readArchiveSleepHost(runtimeArchiveSleepHostDeps(context.runtime), params)
    }
  }),
  defineMethod({
    name: SESSION_ORGANIZATION_RPC.reconcile,
    params: null,
    // Why the window triggers it: it asks once its folder bridge can answer the probe.
    handler: async (_params, context) => {
      assertOrganizationWindowCaller(context)
      return reconcileInterruptedChanges(ledger(), async (records) => {
        const reply = (await context.runtime.requestSessionFolders({
          kind: 'probeOrganization',
          records
        })) as SessionFolderProbeReply | undefined
        return reply?.answers ?? []
      })
    }
  })
]
