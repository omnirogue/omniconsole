// Session prep's reuse, on this runtime: `session find-owner` to pick, a dry-run `session assign`
// to prove the offer can be delivered, and the real `session assign` (audit line and toast
// included) when the person chooses it. The asking conversation is the actor.

import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageActor } from '../../shared/session-manage-types'
import { sessionOwnerShortWhy } from '../../shared/session-owner-types'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import {
  prepareSessionTarget,
  settleSessionAction,
  withPartialAudit
} from '../runtime/rpc/methods/session-manage-support'
import {
  assignSessionOnRuntime,
  findSessionOwnerOnRuntime
} from '../session-manage/session-manage-owner-runtime'
import { readSidebarRows } from '../session-manage/session-manage-runtime-actions'
import { assignByRefOnRuntime } from '../runtime/rpc/methods/session-manage-assign-ref-method'
import { parseSessionReference, rowsForSessionReference } from '../../shared/session-reference'
import { assertSessionPrepReuseWorkspace } from './session-prep-reuse-workspace'
import { shortSessionPrepReason } from './session-prep-ids'
import type { SessionPrepReuse } from './session-prep-reuse'

function askingActor(
  rows: readonly SessionManageSidebarRow[],
  paneKey: string
): SessionManageActor {
  return {
    kind: 'pane',
    paneKey,
    title: rows.find((row) => row.paneKey === paneKey)?.title ?? 'another session'
  }
}

export function createSessionPrepRuntimeReuse(runtime: OrcaRuntimeService): SessionPrepReuse {
  const deliver = async (input: {
    sourcePaneKey: string
    owner: { paneKey: string; tabId: string | null; ref?: string; cwd?: string }
    prompt: string
    dryRun: boolean
    reason?: string
    request?: string
  }): Promise<void> => {
    const rows = await readSidebarRows(runtime)
    await assertSessionPrepReuseWorkspace(runtime, rows, input.owner)
    if (input.owner.ref) {
      await assignByRefOnRuntime(
        { runtime },
        {
          ref: input.owner.ref,
          task: input.prompt,
          reason: input.reason ?? 'session prep: offer a related past conversation',
          ...(input.request ? { request: input.request } : {}),
          dryRun: input.dryRun
        },
        askingActor(rows, input.sourcePaneKey),
        async (cwd) =>
          assertSessionPrepReuseWorkspace(runtime, await readSidebarRows(runtime), input.owner, cwd)
      )
      return
    }
    const prepared = await prepareSessionTarget(runtime, {
      paneKey: input.owner.paneKey,
      ...(input.owner.tabId ? { tabId: input.owner.tabId } : {})
    })
    const actor = askingActor(prepared.rows, input.sourcePaneKey)
    const provenance = {
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.request ? { request: input.request } : {})
    }
    const context = { runtime }
    const { result, entryId } = await withPartialAudit(
      context,
      { actor, entry: prepared.entry },
      'assign',
      provenance,
      () =>
        assignSessionOnRuntime(runtime, {
          actor,
          target: prepared,
          task: input.prompt,
          dryRun: input.dryRun
        })
    )
    await settleSessionAction(
      context,
      { actor, entry: prepared.entry },
      'assign',
      result,
      provenance,
      {
        before: { state: prepared.entry.state, keepGoing: prepared.entry.keepGoing },
        after: { queued: result.sent },
        ...(entryId ? { undoEntryId: entryId, source: prepared.source } : {})
      }
    )
  }
  return {
    find: async ({
      sourcePaneKey,
      task,
      prompt,
      files,
      scope,
      exclude,
      excludeWorktreeIds = []
    }) => {
      const rows = await readSidebarRows(runtime)
      const asker = rows.find((row) => row.paneKey === sourcePaneKey)
      const excludedWorktrees = new Set(excludeWorktreeIds)
      const excludedPaneKeys = new Set(exclude)
      for (const excluded of exclude) {
        const reference = parseSessionReference(excluded)
        if (!reference) {
          continue
        }
        for (const row of rowsForSessionReference(reference, rows)) {
          if (row.paneKey) {
            excludedPaneKeys.add(row.paneKey)
          }
        }
      }
      for (const row of rows) {
        if (excludedWorktrees.has(row.worktreeId) && row.paneKey) {
          excludedPaneKeys.add(row.paneKey)
        }
      }
      const found = await findSessionOwnerOnRuntime(runtime, rows, {
        task,
        files,
        pastWork: true,
        scope: { ...scope, folderId: asker?.folderId ?? null },
        exclude: excludedPaneKeys,
        // These sessions cannot receive an offer, but remain visible to conflict detection.
        conflictExclude: new Set(
          [...excludedPaneKeys].filter((paneKey) => paneKey !== sourcePaneKey)
        )
      })
      const owner = found.owner
      const conflictsUnknown = found.unchecked.filter(
        (entry) => entry.risk === 'possible-file-conflict'
      )
      if (found.launchNew && conflictsUnknown.length > 0) {
        const unchecked = conflictsUnknown.map((entry) => `${entry.title}: ${entry.reason}`)
        return {
          hold: true,
          note: [`Ownership coverage is incomplete: ${found.reason}`, ...unchecked].join('; ')
        }
      }
      if (!owner && found.pastOwner) {
        const past = found.pastOwner
        if (exclude.has(past.ref)) {
          return {
            hold: true,
            note: 'This past conversation already holds another item in the batch.'
          }
        }
        if (parseSessionReference(past.ref)?.hostId !== 'local') {
          return { hold: true, note: 'The past conversation is not on this computer.' }
        }
        const pastOwner = {
          paneKey: past.paneKey ?? past.ref,
          tabId: rows.find((row) => row.paneKey === past.paneKey)?.tabId ?? null,
          ref: past.ref,
          ...(past.cwd ? { cwd: past.cwd } : {})
        }
        if (found.disposition === 'reuse-output') {
          return {
            offer: { ...pastOwner, title: past.title, why: found.reason, kind: 'duplicate' }
          }
        }
        if (found.disposition === 'resume' || found.disposition === 'unarchive-and-continue') {
          try {
            await deliver({ sourcePaneKey, owner: pastOwner, prompt, dryRun: true })
          } catch (error) {
            return { hold: true, note: `Not resumed: ${shortSessionPrepReason(error)}` }
          }
          return {
            offer: {
              ...pastOwner,
              title: past.title,
              kind: 'assign',
              why: `${past.kind}, related past work; confirmation required before continuing`
            }
          }
        }
      }
      if (!owner) {
        if (found.disposition === 'coverage-incomplete' || found.unchecked.length > 0) {
          const unchecked = found.unchecked.map((entry) => `${entry.title}: ${entry.reason}`)
          return {
            note: [`Ownership coverage is incomplete: ${found.reason}`, ...unchecked].join('; ')
          }
        }
        if (found.disposition === 'launch-new') {
          return { note: found.reason }
        }
        return {}
      }
      const offer = {
        paneKey: owner.paneKey,
        tabId: owner.tabId,
        title: owner.title,
        why: sessionOwnerShortWhy(owner)
      }
      // Why no dry run: neither sends anything unless the person picks Launch anyway.
      if (found.disposition === 'duplicate') {
        return { offer: { ...offer, kind: 'duplicate' } }
      }
      if (found.disposition === 'conflict-owner-busy') {
        return { offer: { ...offer, kind: 'conflict-busy' } }
      }
      if (found.disposition === 'busy-related') {
        return {
          note: `“${owner.title}” does related work but is busy (${owner.load}), so a new session was launched${found.unchecked.length ? `; unchecked: ${found.unchecked.map((entry) => `${entry.title}: ${entry.reason}`).join('; ')}` : ''}`
        }
      }
      if (found.disposition !== 'assign') {
        return {}
      }
      try {
        await deliver({ sourcePaneKey, owner, prompt, dryRun: true })
      } catch (error) {
        const note = `Not offered to “${owner.title}”: ${shortSessionPrepReason(error)}`
        if (conflictsUnknown.length > 0) {
          return {
            hold: true,
            note: `${note}; file-conflict coverage is incomplete: ${conflictsUnknown
              .map((entry) => `${entry.title}: ${entry.reason}`)
              .join('; ')}`
          }
        }
        return { note }
      }
      return { offer: { ...offer, kind: 'assign' } }
    },
    assign: ({ sourcePaneKey, owner, prompt, request, reason }) =>
      deliver({ sourcePaneKey, owner, prompt, dryRun: false, reason, request })
  }
}
