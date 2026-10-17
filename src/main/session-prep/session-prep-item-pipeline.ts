import {
  SESSION_PREP_MAX_REPAIRS,
  type GateFailureCode,
  type GateVerdict,
  type PreparedFields
} from '../../shared/session-prep-types'
import {
  isSessionPrepAccountFailure,
  isSessionPrepSignInFailure,
  SessionPrepAccountPreparationError,
  shortSessionPrepReason
} from './session-prep-ids'
import {
  launchPreparedSessionPrepItem,
  launchSessionPrepItem,
  type SessionPrepLaunchContext
} from './session-prep-launch'
import { renderRoutedSessionPrepPrompt } from './session-prep-dispatch-route'
import type { SessionPrepBatchRecord, SessionPrepItemRecord } from './session-prep-records'
import { resolveSessionPrepItemTarget } from './session-prep-target'
import { retargetFromReferences } from './session-prep-retarget'
import { sessionPrepHostId, SessionPrepHostError } from './session-prep-execution-host'

// Why fail closed: an unchecked prompt could carry work the person never asked for; their own
// words cannot, so a check that could not run launches those instead (as a failed prepare does).
const GATE_FAILED_NOTE = 'Launched with your own words: the final check could not run'
// Why: after its repairs, a prompt the check still finds contradicting the request or adding risky
// work nobody asked for must not launch; the person's own words cannot carry either.
const UNSAFE_AFTER_REPAIR = new Set<GateFailureCode>(['contradiction', 'unrequested-risk'])

export async function processSessionPrepItem(
  ctx: SessionPrepLaunchContext,
  batchId: string,
  index: number
): Promise<void> {
  const batch = ctx.batch(batchId)
  const item = requireItem(batch, index)
  if (ctx.isCancelled(batchId, index) || item.state === 'launched') {
    return
  }
  if (item.planned.direct) {
    const prompt = await renderRoutedSessionPrepPrompt(ctx, batch, item, null, (launch) =>
      ctx.steps().renderDirect({
        item: item.planned,
        index,
        request: batch.request,
        siblings: batch.items
          .filter((entry) => entry.index !== index)
          .map((entry) => entry.planned.title),
        batchId,
        launch
      })
    )
    await launchSessionPrepItem(ctx, batchId, index, prompt, null)
    return
  }
  const fields = await prepareFields(ctx, batch, item)
  if (!fields || ctx.isCancelled(batchId, index)) {
    return
  }
  await checkAndLaunch(ctx, batchId, index, fields)
}

async function prepareFields(
  ctx: SessionPrepLaunchContext,
  batch: SessionPrepBatchRecord,
  item: SessionPrepItemRecord
): Promise<PreparedFields | null> {
  item.state = 'preparing'
  await ctx.persist()
  if (ctx.isCancelled(batch.id, item.index)) {
    return null
  }
  const { source, target } = await resolveSessionPrepItemTarget(ctx.host, batch, item)
  await ctx.persist()
  const input = {
    item: item.planned,
    index: item.index,
    siblings: batch.items
      .filter((entry) => entry.index !== item.index)
      .map((entry) => entry.planned),
    request: batch.request,
    context: batch.context,
    cwd: target.path,
    connectionId: target.connectionId,
    repos: ctx.host
      .listRepos()
      .filter((repo) => sessionPrepHostId(repo) === sessionPrepHostId(target))
      .map(({ name, path }) => ({ name, path }))
  }
  let lastError = 'unknown error'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const prepared = await ctx.steps().prepare(input)
      const moved = retargetFromReferences(
        ctx.host
          .listRepos()
          .filter((repo) => sessionPrepHostId(repo) === sessionPrepHostId(target)),
        target.repoId,
        prepared
      )
      if (moved) {
        item.targetRepoId = moved.repo.id
        item.executionTarget =
          moved.repo.id === source.repoId
            ? { ...source }
            : {
                path: moved.repo.path,
                repoId: moved.repo.id,
                isFolder: moved.repo.isFolder,
                isRemote: moved.repo.isRemote,
                connectionId: moved.repo.connectionId,
                connectionGeneration: moved.repo.connectionGeneration,
                connectionBinding: moved.repo.connectionBinding,
                hostId: sessionPrepHostId(moved.repo)
              }
      }
      const fields = moved?.fields ?? prepared
      item.fields = fields
      await ctx.persist()
      return fields
    } catch (error) {
      if (
        error instanceof SessionPrepAccountPreparationError ||
        error instanceof SessionPrepHostError
      ) {
        throw error
      }
      lastError = shortSessionPrepReason(error)
      if (isSessionPrepSignInFailure(lastError)) {
        break
      }
    }
  }
  if (isSessionPrepSignInFailure(lastError)) {
    // Why not the person's words: the launch uses the same sign-in, so that session would die at once.
    item.state = 'failed'
    item.note = `Not launched: the Claude sign-in OmniConsole uses has expired (${lastError}). Sign in again in Settings → Accounts, then send the request again.`
    await ctx.persist()
    return null
  }
  await launchOwnWords(
    ctx,
    batch.id,
    item.index,
    `Launched with your own words: preparation failed (${lastError})`,
    null
  )
  return null
}

async function checkAndLaunch(
  ctx: SessionPrepLaunchContext,
  batchId: string,
  index: number,
  initial: PreparedFields
): Promise<void> {
  let fields = initial
  for (;;) {
    const batch = ctx.batch(batchId)
    const item = requireItem(batch, index)
    if (ctx.isCancelled(batchId, index)) {
      return
    }
    item.state = 'checking'
    await ctx.persist()
    const verdict = await runGate(ctx, batch, item, fields)
    if ('error' in verdict) {
      await launchOwnWords(ctx, batchId, index, `${GATE_FAILED_NOTE} (${verdict.error})`, null)
      return
    }
    item.verdicts = [...item.verdicts, verdict].slice(-3)
    if (verdict.pass || item.repairs >= SESSION_PREP_MAX_REPAIRS) {
      await launchChecked(ctx, batchId, index, fields, verdict)
      return
    }
    item.state = 'repairing'
    await ctx.persist()
    if (ctx.isCancelled(batchId, index)) {
      return
    }
    try {
      const { target } = await resolveSessionPrepItemTarget(ctx.host, batch, item)
      fields = await ctx.steps().revise({
        item: item.planned,
        fields,
        failures: verdict.failures,
        request: batch.request,
        context: batch.context,
        cwd: target.path,
        connectionId: target.connectionId
      })
      item.fields = fields
      item.repairs += 1
      await ctx.persist()
    } catch (error) {
      if (isSessionPrepAccountFailure(error) || error instanceof SessionPrepHostError) {
        throw error
      }
      await launchChecked(ctx, batchId, index, fields, verdict)
      return
    }
  }
}

async function launchChecked(
  ctx: SessionPrepLaunchContext,
  batchId: string,
  index: number,
  fields: PreparedFields,
  verdict: GateVerdict
): Promise<void> {
  const unsafe = verdict.pass
    ? undefined
    : verdict.failures.find((failure) => UNSAFE_AFTER_REPAIR.has(failure.code))
  if (!unsafe) {
    await launchPreparedSessionPrepItem(ctx, batchId, index, fields, verdict)
    return
  }
  await launchOwnWords(
    ctx,
    batchId,
    index,
    `Launched with your own words: the prepared prompt kept failing a check (${unsafe.detail})`,
    verdict
  )
}

async function launchOwnWords(
  ctx: SessionPrepLaunchContext,
  batchId: string,
  index: number,
  note: string,
  verdict: GateVerdict | null
): Promise<void> {
  const batch = ctx.batch(batchId)
  const item = requireItem(batch, index)
  item.note = note
  const prompt = await renderRoutedSessionPrepPrompt(ctx, batch, item, verdict, (launch) =>
    ctx.steps().renderDirect({
      item: item.planned,
      index,
      request: batch.request,
      siblings: batch.items
        .filter((entry) => entry.index !== index)
        .map((entry) => entry.planned.title),
      batchId,
      note,
      ask: verdict?.ask ?? null,
      launch
    })
  )
  await launchSessionPrepItem(ctx, batchId, index, prompt, verdict)
}

async function runGate(
  ctx: SessionPrepLaunchContext,
  batch: SessionPrepBatchRecord,
  item: SessionPrepItemRecord,
  fields: PreparedFields
): Promise<GateVerdict | { error: string }> {
  try {
    const { target } = await resolveSessionPrepItemTarget(ctx.host, batch, item)
    return await ctx.steps().gate({
      item: item.planned,
      fields,
      request: batch.request,
      context: batch.context,
      cwd: target.path,
      connectionId: target.connectionId
    })
  } catch (error) {
    if (isSessionPrepAccountFailure(error) || error instanceof SessionPrepHostError) {
      throw error
    }
    return { error: shortSessionPrepReason(error) }
  }
}

function requireItem(batch: SessionPrepBatchRecord, index: number): SessionPrepItemRecord {
  const item = batch.items.find((entry) => entry.index === index)
  if (!item) {
    throw new Error(`Session prep item ${index} is missing.`)
  }
  return item
}
