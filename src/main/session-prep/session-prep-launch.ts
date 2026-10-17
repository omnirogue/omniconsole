import { sessionPrepConnectorPrompt } from './session-prep-connector-launch'
import type { AgentTemplateText } from '../../shared/agent-template-dispatch'
import type { GateVerdict, PreparedFields, SessionPrepSteps } from '../../shared/session-prep-types'
import { sessionPrepBatchFolder } from './session-prep-batch-folder'
import type { SessionPrepHost } from './session-prep-host'
import { sessionPrepItemLaunchChoice, sessionPrepLaunchLabel } from './session-prep-launch-choice'
import {
  launchSessionPrepSession,
  launchSessionPrepWorktree
} from './session-prep-launch-executors'
import type { SessionPrepBatchRecord, SessionPrepItemRecord } from './session-prep-records'
import {
  sessionPrepReuseExclusions,
  sessionPrepReuseTask,
  reserveSessionPrepReuse,
  type SessionPrepReuse
} from './session-prep-reuse'
import { resolveSessionPrepItemTarget, sessionPrepSessionWorktreeId } from './session-prep-target'
import { renderRoutedSessionPrepPrompt } from './session-prep-dispatch-route'
import { withSessionPrepProject } from './session-prep-project'
import { sessionPrepAgentTemplateId } from './session-prep-agent-template'
import {
  addSessionPrepItemNotes,
  fileSessionPrepItem,
  sessionPrepItemFolder
} from './session-prep-item-folder'
import { sessionPrepVerifyAgent, startSessionPrepVerify } from './session-prep-verify'

export type SessionPrepLaunchContext = {
  host: SessionPrepHost
  steps: () => SessionPrepSteps
  now: () => number
  persist: () => Promise<void>
  isCancelled: (batchId: string, index: number) => boolean
  batch: (batchId: string) => SessionPrepBatchRecord
  /** Offers a free related session instead of launching; absent, every item launches new. */
  reuse?: SessionPrepReuse
  /** The chosen agent template for an item, resolved from this host's settings. */
  agentTemplate?: (
    batch: SessionPrepBatchRecord,
    item: SessionPrepItemRecord
  ) => AgentTemplateText | null
}

export async function launchSessionPrepItem(
  ctx: SessionPrepLaunchContext,
  batchId: string,
  index: number,
  prompt: string,
  verdict: GateVerdict | null
): Promise<void> {
  const batch = ctx.batch(batchId)
  const item = requireItem(batch, index)
  if (ctx.isCancelled(batchId, index)) {
    return
  }
  prompt = sessionPrepConnectorPrompt(prompt, batch.connectorLaunch)
  item.prompt = prompt
  const { source, target } = await resolveSessionPrepItemTarget(ctx.host, batch, item)
  const choice = sessionPrepItemLaunchChoice(ctx.host, batch, item, verdict)
  const changesCode = item.fields?.changesCode ?? item.planned.changesCode
  const newWorktree = changesCode && !target.isFolder
  const worktreeId = newWorktree ? null : sessionPrepSessionWorktreeId(batch, source, target)
  const placement = await sessionPrepItemFolder(ctx.host, batch, item)
  const folder = placement.ref
  const project = await withSessionPrepProject(ctx.host, {
    folder: typeof folder === 'string' ? folder : folder?.id,
    hostId: target.hostId ?? 'local',
    worktreeId,
    prompt,
    templateId: sessionPrepAgentTemplateId(batch, item),
    templated: !!ctx.agentTemplate?.(batch, item)
  })
  if (project.agentTemplateName) {
    item.agentTemplateName = project.agentTemplateName
  }
  // Keep the raw prompt for Launch new; assignment gets this already-resolved project context.
  if (project.prompt !== prompt) {
    item.reusePrompt = project.prompt
  } else {
    delete item.reusePrompt
  }
  // Why local only: find-owner and assign act only on sessions this computer executes.
  const localTarget = !target.isRemote && !target.connectionId
  const reserveReuseLane =
    localTarget && ((!!ctx.reuse && !item.reuse?.decided) || item.reuse?.decided === 'launch')
  let releaseReservation: (() => Promise<void>) | null = null
  if (reserveReuseLane) {
    releaseReservation = await reserveSessionPrepReuse(
      batch,
      item.index,
      ctx.now(),
      ctx.persist,
      () => ctx.isCancelled(batchId, index)
    )
    if (!releaseReservation && ctx.isCancelled(batchId, index)) {
      return
    }
    if (!releaseReservation && !ctx.isCancelled(batchId, index)) {
      throw new Error(
        'A previous session reuse lookup is unresolved; inspect the batch before retrying.'
      )
    }
  }
  try {
    if (
      releaseReservation &&
      !item.reuse?.decided &&
      (await offerReuse(ctx, batch, item, project.prompt, { repoId: target.repoId, worktreeId }))
    ) {
      return
    }
    // Why before the launch: the batch's folder exists before its first row appears.
    const batchFolder = await sessionPrepBatchFolder(ctx, batch, item)
    addSessionPrepItemNotes(item, placement.notes)
    addSessionPrepItemNotes(item, project.notes)
    // Saved with the launch itself, so the session it creates is never left without its binding.
    const verifyAgent = sessionPrepVerifyAgent(ctx, item, choice.agent, localTarget)
    if (verifyAgent) {
      item.verifyPending = { agent: verifyAgent }
    }
    const now = ctx.now()
    const surface =
      worktreeId === null
        ? await launchSessionPrepWorktree(
            ctx,
            batch,
            item,
            target.repoId,
            choice,
            project.prompt,
            now
          )
        : await launchSessionPrepSession(ctx, batch, item, worktreeId, choice, project.prompt, now)
    if (item.state !== 'launched') {
      delete item.verifyPending
      return
    }
    item.launchedWith = sessionPrepLaunchLabel(choice)
    addSessionPrepItemNotes(item, choice.notes)
    if (folder) {
      await fileSessionPrepItem(
        ctx.host,
        item,
        { ref: folder, label: typeof folder === 'string' ? folder : folder.path },
        surface,
        batch.request
      )
    } else if (batchFolder?.ok) {
      await fileSessionPrepItem(
        ctx.host,
        item,
        {
          ref: { id: batchFolder.id, path: batchFolder.path },
          label: batchFolder.path,
          origin: { batchId, index }
        },
        surface,
        batch.request
      )
    } else if (batchFolder) {
      addSessionPrepItemNotes(item, [`Not filed in a batch folder: ${batchFolder.reason}`])
    }
    await ctx.persist()
    if (item.verifyPending) {
      startSessionPrepVerify(ctx, item, item.verifyPending.agent)
    }
  } finally {
    await releaseReservation?.()
  }
}

/** True when the item now waits for the person to choose the offered session or a new one. */
async function offerReuse(
  ctx: SessionPrepLaunchContext,
  batch: SessionPrepBatchRecord,
  item: SessionPrepItemRecord,
  prompt: string,
  scope: { repoId: string; worktreeId: string | null }
): Promise<boolean> {
  if (!ctx.reuse) {
    return false
  }
  const unrecoveredWorktree = batch.items.find(
    (entry) => entry.launched?.paneIdentity === 'unresolved-recovered'
  )
  if (unrecoveredWorktree) {
    if (ctx.isCancelled(batch.id, item.index)) {
      return true
    }
    item.state = 'failed'
    item.note = `Not launched: session prep recovered “${unrecoveredWorktree.fields?.title ?? unrecoveredWorktree.planned.title}” in a new workspace, but its pane identity is unavailable; sibling reuse is held to avoid offering it twice.`
    await ctx.persist()
    return true
  }
  let found: Awaited<ReturnType<SessionPrepReuse['find']>>
  try {
    found = await ctx.reuse.find({
      sourcePaneKey: batch.source.paneKey,
      task: sessionPrepReuseTask(item),
      prompt,
      files: (item.fields?.references ?? []).map((reference) => reference.path),
      scope: {
        repoId: scope.repoId,
        ...(scope.worktreeId
          ? { worktreeId: scope.worktreeId, targetWorktreeId: scope.worktreeId }
          : {})
      },
      exclude: sessionPrepReuseExclusions(batch),
      excludeWorktreeIds: batch.items.flatMap((entry) =>
        entry.launched?.newWorkspace &&
        !entry.launched.paneKey &&
        (entry.launched.paneIdentity === 'pending' ||
          entry.launched.paneIdentity === 'unresolved-launched')
          ? [entry.launched.worktreeId]
          : []
      )
    })
  } catch {
    // Why silent: looking for a session to reuse is optional; launching new is the default.
    return false
  }
  if (!('offer' in found)) {
    if (ctx.isCancelled(batch.id, item.index)) {
      return true
    }
    if (found.hold) {
      item.state = 'failed'
      item.note = `Not launched: ${found.note ?? 'session ownership could not be verified'}`
      await ctx.persist()
      return true
    }
    addSessionPrepItemNotes(item, found.note ? [found.note] : [])
    return false
  }
  if (ctx.isCancelled(batch.id, item.index)) {
    return true
  }
  if (
    found.offer.kind !== 'conflict-busy' &&
    sessionPrepReuseExclusions(batch).has(found.offer.paneKey)
  ) {
    return false
  }
  item.state = 'awaiting-reuse'
  item.reuse = { ...found.offer }
  await ctx.persist()
  return true
}

export async function launchPreparedSessionPrepItem(
  ctx: SessionPrepLaunchContext,
  batchId: string,
  index: number,
  fields: PreparedFields,
  verdict: GateVerdict
): Promise<void> {
  const batch = ctx.batch(batchId)
  const item = requireItem(batch, index)
  const siblings = batch.items
    .filter((entry) => entry.index !== index)
    .map((entry) => entry.fields?.title ?? entry.planned.title)
  const prompt = await renderRoutedSessionPrepPrompt(ctx, batch, item, verdict, (launch) =>
    ctx.steps().render({
      fields,
      item: item.planned,
      index,
      request: batch.request,
      batchId,
      ask: verdict.ask,
      siblings,
      unresolved: verdict.pass ? [] : verdict.failures,
      launch
    })
  )
  await launchSessionPrepItem(ctx, batchId, index, prompt, verdict)
}

function requireItem(batch: SessionPrepBatchRecord, index: number): SessionPrepItemRecord {
  const item = batch.items.find((entry) => entry.index === index)
  if (!item) {
    throw new Error(`Session prep item ${index} is missing.`)
  }
  return item
}
