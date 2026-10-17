import { SessionPrepRoutedModelUnavailableError } from './session-prep-routed-launch'
import type { SessionPrepBatchRecord, SessionPrepItemRecord } from './session-prep-records'
import type { SessionPrepLaunchedSurface } from './session-prep-folders'
import type { SessionPrepLaunchContext } from './session-prep-launch'
import { addSessionPrepItemNotes } from './session-prep-item-folder'
import {
  createSessionPrepOperationId,
  sessionPrepWorktreeName,
  shortSessionPrepReason
} from './session-prep-ids'
import {
  sessionPrepLaunchPreferences,
  type SessionPrepLaunchChoice
} from './session-prep-launch-choice'

export async function launchSessionPrepWorktree(
  ctx: SessionPrepLaunchContext,
  batch: SessionPrepBatchRecord,
  item: SessionPrepItemRecord,
  repoId: string,
  choice: SessionPrepLaunchChoice,
  prompt: string,
  now: number
): Promise<SessionPrepLaunchedSurface | undefined> {
  const name = sessionPrepWorktreeName(
    item.fields?.title ?? item.planned.title,
    batch.id,
    item.index
  )
  if (ctx.isCancelled(batch.id, item.index)) {
    return undefined
  }
  item.state = 'launching'
  item.launch = { kind: 'worktree', name, startedAt: now }
  await ctx.persist()
  try {
    const created = await ctx.host.createWorktreeWithAgent({
      batchId: batch.id,
      ...(batch.connectorLaunch ? { connectorLaunch: batch.connectorLaunch } : {}),
      repoId,
      expectedWorkspace: item.executionTarget,
      name,
      agent: choice.agent,
      prompt,
      ...(choice.routedModel ? { routedModel: choice.routedModel } : {}),
      ...(sessionPrepLaunchPreferences(choice)
        ? { launch: sessionPrepLaunchPreferences(choice) }
        : {})
    })
    item.state = 'launched'
    item.launched = {
      worktreeId: created.worktreeId,
      ...(created.surface?.nativeReceipt ? { nativeReceipt: created.surface.nativeReceipt } : {}),
      newWorkspace: true,
      at: ctx.now(),
      ...(created.paneHandle ? { paneHandle: created.paneHandle } : {}),
      ...(created.surface?.paneKey
        ? { paneKey: created.surface.paneKey }
        : created.paneHandle
          ? { paneIdentity: 'pending' as const }
          : { paneIdentity: 'unresolved-launched' as const })
    }
    reopenIfCancelled(batch)
    // The workspace and terminal handle are durable before waiting for its stable pane key.
    await ctx.persist()
    if (!item.launched.paneKey && created.paneHandle && ctx.host.resolveTerminalPaneKey) {
      try {
        const paneKey = await ctx.host.resolveTerminalPaneKey(created.paneHandle)
        if (paneKey) {
          item.launched.paneKey = paneKey
          delete item.launched.paneIdentity
        } else {
          item.launched.paneIdentity = 'unresolved-launched'
          addSessionPrepItemNotes(item, [
            'The new workspace launched, but its pane identity is still unavailable; it will not be reused automatically.'
          ])
        }
      } catch {
        item.launched.paneIdentity = 'unresolved-launched'
        addSessionPrepItemNotes(item, [
          'The new workspace launched, but its pane identity could not be verified; it will not be reused automatically.'
        ])
      }
      await ctx.persist()
      if (paneKeyFromLaunched(item)) {
        return { ...created.surface, paneKey: paneKeyFromLaunched(item) }
      }
    } else if (!item.launched.paneKey) {
      item.launched.paneIdentity = 'unresolved-launched'
      addSessionPrepItemNotes(item, [
        'The new workspace launched, but its pane identity is unavailable; it will not be reused automatically.'
      ])
      await ctx.persist()
    }
    return created.surface
  } catch (error) {
    if (error instanceof SessionPrepRoutedModelUnavailableError) {
      item.route = {
        status: 'unavailable',
        blocking: true,
        mode: 'live',
        at: ctx.now(),
        unrouted: error.message
      }
    }
    failItem(item, shortSessionPrepReason(error))
    await ctx.persist()
    return undefined
  }
}

function paneKeyFromLaunched(item: SessionPrepItemRecord): string | undefined {
  return item.launched?.paneKey
}

export async function launchSessionPrepSession(
  ctx: SessionPrepLaunchContext,
  batch: SessionPrepBatchRecord,
  item: SessionPrepItemRecord,
  worktreeId: string,
  choice: SessionPrepLaunchChoice,
  prompt: string,
  now: number
): Promise<SessionPrepLaunchedSurface | undefined> {
  const operationId = batch.connectorLaunch?.nativeOperationId ?? createSessionPrepOperationId(now)
  if (ctx.isCancelled(batch.id, item.index)) {
    return undefined
  }
  item.state = 'launching'
  item.launch = { kind: 'session', operationId, startedAt: now }
  await ctx.persist()
  try {
    const surface = await ctx.host.createAgentSessionIn({
      batchId: batch.id,
      ...(batch.connectorLaunch ? { connectorLaunch: batch.connectorLaunch } : {}),
      worktreeId,
      expectedWorkspace: item.executionTarget,
      agent: choice.agent,
      prompt,
      clientOperationId: operationId,
      ...(choice.routedModel ? { routedModel: choice.routedModel } : {}),
      ...(sessionPrepLaunchPreferences(choice)
        ? { launch: sessionPrepLaunchPreferences(choice) }
        : {})
    })
    item.state = 'launched'
    item.launched = {
      worktreeId,
      ...(surface?.nativeReceipt ? { nativeReceipt: surface.nativeReceipt } : {}),
      newWorkspace: false,
      at: ctx.now(),
      ...(surface?.paneKey ? { paneKey: surface.paneKey } : {})
    }
    reopenIfCancelled(batch)
    await ctx.persist()
    return surface ?? undefined
  } catch (error) {
    if (error instanceof SessionPrepRoutedModelUnavailableError) {
      item.route = {
        status: 'unavailable',
        blocking: true,
        mode: 'live',
        at: ctx.now(),
        unrouted: error.message
      }
    }
    failItem(item, shortSessionPrepReason(error))
    await ctx.persist()
    return undefined
  }
}

function failItem(item: SessionPrepItemRecord, note: string): void {
  item.state = 'failed'
  item.note = note
}

function reopenIfCancelled(batch: SessionPrepBatchRecord): void {
  if (batch.state === 'cancelled') {
    batch.state = 'done'
  }
}
