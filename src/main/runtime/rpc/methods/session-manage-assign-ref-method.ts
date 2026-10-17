// `sessionManage.assign` with `ref`: `assignByRef` on this runtime. Unarchive is the recorded
// organization change (`mutateSessionFolders`), resume is `session resume`, and the task is
// `session assign` on the pane it ends up in; each writes its own audit line.

import type { z } from 'zod'
import type {
  SessionManageActionResult,
  SessionManageActor
} from '../../../../shared/session-manage-types'
import { parseSessionReference } from '../../../../shared/session-reference'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import {
  assignByRef,
  type AssignRefResult
} from '../../../session-manage/session-manage-assign-ref'
import { readTranscriptLatestTurn } from '../../../session-manage/session-manage-first-turn'
import { toSessionManageEntry } from '../../../session-manage/session-manage-inventory'
import { observeSession } from '../../../session-manage/session-manage-observe'
import {
  assignSessionOnRuntime,
  runtimeChainBound
} from '../../../session-manage/session-manage-owner-runtime'
import { resumeConversation } from '../../../session-manage/session-manage-resume'
import { runtimeResumeDeps } from '../../../session-manage/session-manage-resume-runtime'
import { readSidebarRows } from '../../../session-manage/session-manage-runtime-actions'
import { createRuntimeObserveSources } from '../../../session-manage/session-manage-runtime-sources'
import { assertUnattendedPolicy } from '../../../session-manage/session-manage-unattended'
import { locateTranscripts } from '../../../session-manage/session-transcript-locate'
import type { RpcContext } from '../core'
import { mutateSessionFolders } from './session-folders'
import type { SessionManageAssignParams } from './session-manage-schemas'
import {
  actorFor,
  prepareSessionAction,
  recordSessionAction,
  settleSessionAction,
  withPartialAudit
} from './session-manage-support'

type AssignParams = z.infer<typeof SessionManageAssignParams>

/** `session assign` on one pane; with `firstTurn`, its reply is read from its transcript. */
export async function assignOnPane(
  context: RpcContext,
  target: { paneKey?: string; tabId?: string },
  params: Pick<AssignParams, 'task' | 'reason' | 'request' | 'dryRun'>,
  firstTurn = false,
  internalActor?: SessionManageActor
): Promise<{ result: SessionManageActionResult; entryId?: string }> {
  const prepared = await prepareSessionAction(context, target)
  if (internalActor) {
    prepared.actor = internalActor
  }
  const reference = parseSessionReference(prepared.entry.ref ?? '')
  const transcript = async (): Promise<string | null> => {
    if (prepared.row.transcriptPath) {
      return prepared.row.transcriptPath
    }
    const found = reference
      ? await locateTranscripts(reference.agent, reference.sessionId, {
          userDataPath: getProfileUserDataPath()
        })
      : []
    return found.length === 1 ? found[0]!.path : null
  }
  const readFirstTurn = async () => {
    const path = await transcript()
    if (!path || !reference) {
      throw new Error('Its transcript could not be found.')
    }
    return readTranscriptLatestTurn(reference.agent, path)
  }
  const { result, entryId } = await withPartialAudit(context, prepared, 'assign', params, () =>
    assignSessionOnRuntime(context.runtime, {
      actor: prepared.actor,
      target: prepared,
      task: params.task,
      dryRun: params.dryRun === true,
      ...(firstTurn ? { firstTurn: readFirstTurn } : {})
    })
  )
  const settled = await settleSessionAction(context, prepared, 'assign', result, params, {
    before: { state: prepared.entry.state, keepGoing: prepared.entry.keepGoing },
    after: { queued: result.sent, ...(firstTurn ? { firstTurn: 'transcript' } : {}) },
    ...(entryId ? { undoEntryId: entryId, source: prepared.source } : {})
  })
  return { result: settled, ...(entryId ? { entryId } : {}) }
}

export async function assignByRefOnRuntime(
  context: RpcContext,
  params: AssignParams & { ref: string },
  internalActor?: SessionManageActor,
  beforeResume?: (cwd: string) => Promise<void>
): Promise<AssignRefResult['result']> {
  const { runtime } = context
  const dryRun = params.dryRun === true
  const actor =
    internalActor ??
    actorFor(
      context,
      context.orchestrationCompatibilityEvidence ? await readSidebarRows(runtime) : []
    )
  // Why first: a steward run must be refused before any unarchive or resume, not after.
  assertUnattendedPolicy(actor, 'assign')
  const { result } = await assignByRef(
    {
      readRows: () => readSidebarRows(runtime),
      observe: async (row) => ({
        entry: toSessionManageEntry(
          await observeSession(row, createRuntimeObserveSources(runtime))
        ),
        bound: runtimeChainBound(runtime, row)
      }),
      unarchive: async (row, preview) =>
        mutateSessionFolders(
          context,
          {
            op: {
              kind: 'archiveSession',
              paneKey: row.paneKey!,
              ...(row.tabId ? { tabId: row.tabId } : {}),
              archived: false
            },
            reason: params.reason,
            ...(params.request ? { request: params.request } : {}),
            ...(preview ? { dryRun: true } : {})
          },
          internalActor
        ),
      resume: async (preview) => {
        const deps = runtimeResumeDeps(runtime, {
          userDataPath: getProfileUserDataPath(),
          ...(context.signal ? { signal: context.signal } : {})
        })
        const resumed = await resumeConversation(
          {
            ...deps,
            transcriptCwd: async (reference, path) => {
              const cwd = await deps.transcriptCwd(reference, path)
              if (cwd) {
                await beforeResume?.(cwd)
              }
              return cwd
            },
            restart: async (row, entry) => {
              if (beforeResume) {
                if (!row.worktreePath) {
                  throw new Error('The checkpoint workspace could not be verified.')
                }
                await beforeResume(row.worktreePath)
              }
              return deps.restart(row, entry)
            },
            launch: async (input) => {
              await beforeResume?.(input.cwd)
              return deps.launch(input)
            }
          },
          { actor, ref: params.ref, dryRun: preview }
        )
        if (!preview && resumed.outcome !== 'already-open') {
          await recordSessionAction({
            actor,
            action: 'resume',
            target: {
              paneKey: resumed.paneKey ?? null,
              tabId: resumed.tabId ?? null,
              title: params.ref
            },
            summary: resumed.summary,
            provenance: params,
            before: { ref: params.ref },
            after: { outcome: resumed.outcome, for: 'assign' }
          })
        }
        return resumed
      },
      assign: (paneKey, options) =>
        assignOnPane(
          context,
          { paneKey },
          { ...params, dryRun: options.dryRun },
          options.firstTurn,
          internalActor
        ),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now()
    },
    { ref: params.ref, dryRun }
  )
  return result
}
