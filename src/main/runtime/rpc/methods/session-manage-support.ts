// What every `sessionManage.*` action does around its own work: admit the caller, read the sidebar,
// find and observe the target, name the actor, and after an applied change write the audit line
// and show the toast.

import type { ConversationSource } from '../../../../shared/conversation-source'
import type { SessionFolderListResult } from '../../../../shared/session-folder-cli'
import {
  resolveSessionFolderRef,
  SAVED_SESSIONS_REF_ID
} from '../../../../shared/session-folder-ref'
import type { SessionManageSidebarRow } from '../../../../shared/session-manage-relay'
import type { SessionProjectReadResult } from '../../../../shared/session-project-cli'
import type {
  SessionManageAction,
  SessionManageActor,
  SessionManageEntry
} from '../../../../shared/session-manage-types'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import { auditActor, sessionActionsLogFor } from '../../../session-manage/session-actions-log'
import {
  assertSessionManageCaller,
  resolveSessionManageActor
} from '../../../session-manage/session-manage-caller'
import {
  describeMissingTarget,
  findSessionManageRow,
  toSessionManageEntry
} from '../../../session-manage/session-manage-inventory'
import { observeSession } from '../../../session-manage/session-manage-observe'
import {
  readSidebarRows,
  runtimePaneVerifier,
  showSessionManageNotice
} from '../../../session-manage/session-manage-runtime-actions'
import { createRuntimeObserveSources } from '../../../session-manage/session-manage-runtime-sources'
import { SessionManagePartialError } from '../../../session-manage/session-manage-refusal'
import { withUnattendedContext } from '../../../session-manage/session-manage-unattended'
import type { TerminalAgentProcessProof } from '../../../runtime/terminal-agent-process'
import type { RpcContext } from '../core'
import type { SessionManageProvenance, SessionManageTargetInput } from './session-manage-schemas'

export type PreparedSessionAction = {
  rows: SessionManageSidebarRow[]
  row: SessionManageSidebarRow
  entry: SessionManageEntry
  source: ConversationSource | null
  /** The pid proof a prompt to this terminal is bound to (`agentForeground: true`). */
  agentProcess: TerminalAgentProcessProof | null
  actor: SessionManageActor
}

/** The folder id `--folder <id|path>` names (Saved Sessions included), or an error naming why not. */
export async function folderFilterId(context: RpcContext, ref: string): Promise<string> {
  const { folders } = (await context.runtime.requestSessionFolders({
    kind: 'list'
  })) as SessionFolderListResult
  const resolved = resolveSessionFolderRef(folders, ref)
  if (!resolved.ok) {
    throw new Error(resolved.error)
  }
  return resolved.target.kind === 'folder' ? resolved.target.folder.id : SAVED_SESSIONS_REF_ID
}

/** The project `--project <id|path>` names: the folder's own, or the one it is in. */
export async function projectFilter(
  context: RpcContext,
  ref: string
): Promise<{ folderId: string; name: string; path: string }> {
  const { folder, project } = (await context.runtime.requestSessionFolders({
    kind: 'readProject',
    folder: ref
  })) as SessionProjectReadResult
  if (!project) {
    throw new Error(
      `“${folder.path}” is not in a project. A project is a top-level folder, or a folder inside a company folder, that a person set up as one.`
    )
  }
  if (!project.settings) {
    throw new Error(
      `“${project.path}” is not a project yet. A person sets it up in OmniConsole; omni folder project-suggest can suggest it.`
    )
  }
  return { folderId: project.folderId, name: project.name, path: project.path }
}

/**
 * The caller as proven by its evidence; a registered automatic run's pane, or a socket caller the
 * dispatcher bound to an automatic run's process tree, is stamped unattended.
 */
export function actorFor(
  context: RpcContext,
  rows: readonly SessionManageSidebarRow[]
): SessionManageActor {
  const actor = withUnattendedContext(
    resolveSessionManageActor(
      context.orchestrationCompatibilityEvidence,
      runtimePaneVerifier(context.runtime),
      (paneKey) => rows.find((row) => row.paneKey === paneKey)?.title ?? null
    )
  )
  return context.unattendedCaller && actor.kind !== 'steward' && !actor.unattended
    ? { ...actor, unattended: context.unattendedCaller }
    : actor
}

/** The target read and observed now, for an action whose actor is already known. */
export async function prepareSessionTarget(
  runtime: RpcContext['runtime'],
  target: SessionManageTargetInput
): Promise<Omit<PreparedSessionAction, 'actor'>> {
  const rows = await readSidebarRows(runtime)
  const row = findSessionManageRow(rows, target)
  if (!row) {
    throw new Error(describeMissingTarget(target))
  }
  const observed = await observeSession(row, createRuntimeObserveSources(runtime))
  return {
    rows,
    row,
    entry: toSessionManageEntry(observed),
    source: observed.source,
    agentProcess: observed.agentProcess
  }
}

export async function prepareSessionAction(
  context: RpcContext,
  target: SessionManageTargetInput
): Promise<PreparedSessionAction> {
  assertSessionManageCaller(context)
  const prepared = await prepareSessionTarget(context.runtime, target)
  return { ...prepared, actor: actorFor(context, prepared.rows) }
}

/** One audit line for an applied action; resolves with a warning when it could not be written. */
export function recordSessionAction(input: {
  actor: SessionManageActor
  action: SessionManageAction
  target: { paneKey?: string | null; tabId?: string | null; title?: string; folder?: string }
  summary: string
  provenance: SessionManageProvenance
  before?: unknown
  after?: unknown
}): Promise<string | undefined> {
  const { provenance } = input
  return sessionActionsLogFor(getProfileUserDataPath()).append({
    ...auditActor(input.actor),
    action: input.action,
    target: input.target,
    ...(input.before !== undefined ? { before: input.before } : {}),
    ...(input.after !== undefined ? { after: input.after } : {}),
    summary: input.summary,
    ...(provenance.reason ? { reason: provenance.reason } : {}),
    ...(provenance.request ? { request: provenance.request } : {})
  })
}

/**
 * Runs an action; when it fails after part of it applied (`SessionManagePartialError`), what did
 * change is audited and shown before the error reaches the caller.
 */
export async function withPartialAudit<T>(
  context: Pick<RpcContext, 'runtime'>,
  prepared: Pick<PreparedSessionAction, 'actor' | 'entry'>,
  action: SessionManageAction,
  provenance: SessionManageProvenance,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof SessionManagePartialError) {
      const auditError = await recordSessionAction({
        actor: prepared.actor,
        action,
        target: {
          paneKey: prepared.entry.paneKey,
          tabId: prepared.entry.tabId,
          title: prepared.entry.title
        },
        summary: `Partly applied: ${error.message}`,
        provenance,
        before: error.audit?.before ?? { keepGoing: prepared.entry.keepGoing },
        after: { ...error.audit?.after, applied: error.applied, completed: false }
      })
      if (auditError) {
        error.message += ` Audit warning: ${auditError}`
      }
      showSessionManageNotice(context.runtime, { kind: 'notice', summary: error.message })
    }
    throw error
  }
}

/** Audit plus toast for an applied action; a dry run records and shows nothing. */
export async function settleSessionAction<T extends { summary: string; dryRun: boolean }>(
  context: Pick<RpcContext, 'runtime'>,
  prepared: Pick<PreparedSessionAction, 'actor' | 'entry'>,
  action: SessionManageAction,
  result: T,
  provenance: SessionManageProvenance,
  extra: {
    before?: unknown
    after?: unknown
    undoEntryId?: string
    source?: ConversationSource | null
    /** The window already showed its own toast for this change (rename, resume). */
    windowToastShown?: boolean
  } = {}
): Promise<T & { auditError?: string }> {
  if (result.dryRun) {
    return result
  }
  const auditError = await recordSessionAction({
    actor: prepared.actor,
    action,
    target: {
      paneKey: prepared.entry.paneKey,
      tabId: prepared.entry.tabId,
      title: prepared.entry.title
    },
    summary: result.summary,
    provenance,
    before: extra.before,
    after: extra.after
  })
  if (!extra.windowToastShown) {
    showSessionManageNotice(context.runtime, {
      kind: 'notice',
      summary: result.summary,
      ...(extra.undoEntryId && extra.source
        ? { undo: { kind: 'dequeue', source: extra.source, entryId: extra.undoEntryId } }
        : {})
    })
  }
  return auditError ? { ...result, auditError } : result
}
