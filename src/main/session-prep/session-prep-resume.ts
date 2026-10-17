import { launchSessionPrepItem, type SessionPrepLaunchContext } from './session-prep-launch'
import { startSessionPrepVerify } from './session-prep-verify'
import {
  SESSION_PREP_TERMINAL_BATCH,
  SESSION_PREP_TERMINAL_ITEM,
  type SessionPrepBatchRecord,
  type SessionPrepItemRecord
} from './session-prep-records'
import { resolveSessionPrepItemTarget } from './session-prep-target'
import { reconcileSessionPrepReuseReservation } from './session-prep-reuse'

const SESSION_INTERRUPT_NOTE = 'Interrupted while launching; check the workspace'
const SSH_INTERRUPT_NOTE =
  'SSH launch outcome is unverified after interruption. Inspect the target workspace before retrying; no additional session was launched.'

export async function resumeSessionPrepBatch(
  ctx: SessionPrepLaunchContext,
  batch: SessionPrepBatchRecord
): Promise<'plan' | 'pump' | 'wait' | 'idle'> {
  // Before the terminal check: a finished batch can still owe a session its verify binding.
  for (const item of batch.items) {
    if (
      item.verifyPending &&
      !item.verifyPending.exhausted &&
      item.state === 'launched' &&
      item.launched
    ) {
      startSessionPrepVerify(ctx, item, item.verifyPending.agent)
    }
  }
  if (SESSION_PREP_TERMINAL_BATCH.has(batch.state)) {
    return 'idle'
  }
  if (batch.state === 'planning') {
    return 'plan'
  }
  if (batch.state === 'awaiting-confirm') {
    return 'wait'
  }
  // Clear only the interrupted lookup/launch gap before any saved Launch new choice or
  // worktree retry attempts to reserve the lane again.
  await reconcileSessionPrepReuseReservation(batch, ctx.persist)
  for (const item of batch.items) {
    if (item.state === 'launched' && item.launched?.paneIdentity === 'pending') {
      const handle = item.launched.paneHandle
      const paneKey = handle
        ? await ctx.host.resolveTerminalPaneKey?.(handle).catch(() => null)
        : null
      if (paneKey) {
        item.launched.paneKey = paneKey
        delete item.launched.paneIdentity
        delete item.note
      } else {
        item.launched.paneIdentity = 'unresolved-launched'
        item.note =
          'The new workspace launched, but its pane identity could not be recovered; it will not be reused automatically.'
      }
      await ctx.persist()
    }
  }
  for (const item of batch.items) {
    if (item.state === 'preparing' || item.state === 'checking' || item.state === 'repairing') {
      item.state = 'planned'
    } else if (item.state === 'launching') {
      await resumeLaunchingItem(ctx, batch, item)
    } else if (item.state === 'awaiting-reuse' && item.reuse?.decided === 'launch') {
      await relaunchStoredPrompt(ctx, batch, item)
    } else if (item.state === 'awaiting-reuse' && item.reuse?.decided === 'skip') {
      item.state = 'already-covered'
    } else if (item.state === 'awaiting-reuse' && item.reuse?.decided === 'assign') {
      // Why not retry: the task may already sit in that session's queue.
      item.state = 'failed'
      item.note = `Interrupted while giving it to “${item.reuse.title}”; check that session before asking again.`
    }
  }
  // A lookup has no external effect before it records an offer; durable outcomes remain on item records.
  await ctx.persist()
  return 'pump'
}

async function resumeLaunchingItem(
  ctx: SessionPrepLaunchContext,
  batch: SessionPrepBatchRecord,
  item: SessionPrepItemRecord
): Promise<void> {
  // A disconnected/cached worktree row cannot prove whether its remote startup ran.
  // Preserve the attempt and require inspection; a retry could create a second executor.
  if (item.executionTarget?.connectionId) {
    item.state = 'failed'
    item.note = SSH_INTERRUPT_NOTE
    return
  }
  if (batch.connectorLaunch) {
    item.state = 'failed'
    item.note =
      'Interrupted connector launch; inspect the native operation before retrying. A workspace alone does not prove the managed session launched.'
    return
  }
  if (item.launch?.kind === 'session') {
    item.state = 'failed'
    item.note = SESSION_INTERRUPT_NOTE
    return
  }
  if (item.launch?.kind === 'worktree' && item.launch.name) {
    const { target } = await resolveSessionPrepItemTarget(ctx.host, batch, item)
    if (target.connectionId) {
      item.state = 'failed'
      item.note = SSH_INTERRUPT_NOTE
      return
    }
    if (await ctx.host.worktreeExistsByName(target.repoId, item.launch.name)) {
      const worktreeId =
        (await ctx.host.findWorktreeIdByName(target.repoId, item.launch.name)) ?? ''
      item.state = 'launched'
      item.launched = {
        worktreeId,
        newWorkspace: true,
        at: ctx.now(),
        paneIdentity: 'unresolved-recovered'
      }
      item.note =
        'Recovered the new workspace after interruption; its startup pane identity is unavailable.'
      return
    }
  }
  if (item.prompt && !SESSION_PREP_TERMINAL_ITEM.has(item.state)) {
    item.state = 'planned'
    await relaunchStoredPrompt(ctx, batch, item)
  } else {
    item.state = 'planned'
  }
}

async function relaunchStoredPrompt(
  ctx: SessionPrepLaunchContext,
  batch: SessionPrepBatchRecord,
  item: SessionPrepItemRecord
): Promise<void> {
  const prompt = item.prompt
  if (!prompt) {
    return
  }
  await launchSessionPrepItem(ctx, batch.id, item.index, prompt, lastVerdict(item))
}

function lastVerdict(item: SessionPrepItemRecord) {
  return item.verdicts.at(-1) ?? null
}
