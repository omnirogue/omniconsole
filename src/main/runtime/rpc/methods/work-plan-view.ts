import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { planArtifactPathFor } from '../../../../shared/work-plan-plan-output'
import { readWorkPlanArtifact } from '../../../../shared/work-plan-artifact-schema'
import {
  renderWorkPlanHtml,
  type WorkPlanReportSeatState
} from '../../../../shared/work-plan-report'
import { sessionOutcomePlanOutcome } from '../../../../shared/session-outcome-plan-state'
import {
  assertSessionOutcomeExecutionScope,
  assertSessionOutcomeRuntime
} from '../../session-outcome-host-boundary'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'

const safeId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const Params = z
  .object({ id: safeId, expectedExecutionRuntimeId: z.string().min(1).optional() })
  .strict()
const queues = new Map<string, Promise<unknown>>()

async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(action)
  queues.set(key, next)
  try {
    return await next
  } finally {
    if (queues.get(key) === next) {
      queues.delete(key)
    }
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function safeDirectory(workspace: string, segments: string[]): Promise<string> {
  let directory = await realpath(workspace)
  for (const segment of segments) {
    directory = join(directory, segment)
    await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error
      }
    })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Plan output must be a real directory.')
    }
  }
  return directory
}

async function writeChanged(path: string, content: string): Promise<boolean> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error
    }
    return null
  })
  if (info?.isSymbolicLink()) {
    throw new Error('Plan output may not be a symlink.')
  }
  if ((await readOptional(path)) === content) {
    return false
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error
      }
    })
  }
  return true
}

function runtimeSeats(chain: SessionChain): Record<string, WorkPlanReportSeatState> {
  const seats: Record<string, WorkPlanReportSeatState> = {}
  for (const step of chain.steps) {
    const attempt = chain.outcomeSet?.attempts.findLast(
      (entry) =>
        entry.actionId === `step_${step.id}` &&
        entry.state !== 'superseded' &&
        (entry.planVersion ?? (step.kind === 'handoff' ? 1 : (step.planVersion ?? 1))) ===
          (chain.planVersion ?? 1)
    )
    if (attempt) {
      seats[step.id] =
        attempt.state === 'running' || attempt.state === 'launching'
          ? 'running'
          : attempt.state === 'completed'
            ? 'done'
            : attempt.state === 'blocked'
              ? 'failed'
              : attempt.state === 'unverifiable'
                ? 'waiting'
                : 'queued'
    }
  }
  return seats
}

export type RenderedWorkPlan = {
  path: string
  contentHash: string
  planVersion: number
  revision: number
  rewritten: boolean
}

/** Reads the committed chain and delivered artifact; callers cannot supply report state. */
export async function renderWorkPlanView(chain: SessionChain): Promise<RenderedWorkPlan> {
  safeId.parse(chain.id)
  const outcome = sessionOutcomePlanOutcome(chain)
  if (!outcome) {
    throw new Error('This chain has no plan outcome.')
  }
  const planVersion = chain.planVersion ?? 1
  const directory = await safeDirectory(chain.workspacePath, ['.omni', 'runs', chain.id])
  const candidates = chain.steps
    .filter(
      (step) =>
        (outcome.stepIds ?? []).includes(step.id) &&
        (step.kind === 'handoff' ? 1 : (step.planVersion ?? 1)) === planVersion
    )
    .toReversed()
  let artifact: ReturnType<typeof readWorkPlanArtifact> | undefined
  let artifactDirectory = directory
  for (const step of candidates) {
    safeId.parse(step.id)
    const path = planArtifactPathFor(chain, step.id)
    const canonical = await realpath(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    })
    if (canonical === null) {
      continue
    }
    const rel = relative(directory, canonical)
    if (rel.startsWith(`..${sep}`) || rel === '..' || resolve(directory, rel) !== canonical) {
      throw new Error('Plan artifact escaped its output directory.')
    }
    artifact = readWorkPlanArtifact(await readFile(canonical, 'utf8'))
    artifactDirectory = dirname(canonical)
    break
  }
  if (!artifact?.ok) {
    throw new Error(artifact?.problem ?? 'No delivered plan artifact exists.')
  }
  // Inline mockups so the published report has the same content as the local view.
  const mockups = await Promise.all(
    artifact.plan.mockups.map(async (mockup) => {
      const path = await realpath(join(artifactDirectory, mockup.file))
      const rel = relative(artifactDirectory, path)
      if (rel === '..' || rel.startsWith(`..${sep}`)) {
        throw new Error('Mockup escaped its output directory.')
      }
      return {
        ...mockup,
        file: `data:text/html;base64,${Buffer.from(await readFile(path)).toString('base64')}`
      }
    })
  )
  const content = renderWorkPlanHtml(
    chain,
    outcome,
    { ...artifact.plan, mockups },
    {
      now: chain.updatedAt,
      planVersion,
      seats: runtimeSeats(chain)
    }
  )
  const contentHash = createHash('sha256').update(content).digest('hex')
  const path = join(directory, 'plan-view.html')
  return {
    path,
    contentHash,
    planVersion,
    revision: outcome.revision,
    rewritten: await writeChanged(path, content)
  }
}

async function execute(
  params: z.infer<typeof Params>,
  context: RpcContext,
  operation: 'render' | 'open' | 'publish'
) {
  assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
  const { runtime } = context
  const chain = runtime.getSessionOutcomeService().get(params.id)
  await assertSessionOutcomeExecutionScope(runtime, chain)
  return serialized(JSON.stringify([chain.workspacePath, chain.id]), async () => {
    const rendered = await renderWorkPlanView(chain)
    if (operation === 'render') {
      return rendered
    }
    if (operation === 'open') {
      const opened = await runtime.openMobileFile(
        `id:${chain.worktreeId}`,
        `.omni/runs/${chain.id}/plan-view.html`
      )
      if (!opened.opened) {
        throw new Error('The plan viewer is unavailable.')
      }
      return { ...rendered, opened: true }
    }
    const sourceKey = JSON.stringify([
      'work-plan',
      chain.workspacePath,
      chain.id,
      rendered.planVersion,
      rendered.revision,
      rendered.contentHash
    ])
    // The publisher's profile-scoped durable record also closes the crash-before-sidecar window.
    const existing = await runtime.getPublishedArtifactLink({ sourceKey })
    if (existing.status !== 'ok') {
      throw new Error(`Artifact publishing: ${existing.status}`)
    }
    let reference = existing.value
    if (!reference) {
      const result = await runtime.publishArtifact({
        sourceKey,
        content: await readFile(rendered.path, 'utf8'),
        contentType: 'text/html',
        fileName: 'plan-view.html',
        title: sessionOutcomePlanOutcome(chain)!.title
      })
      if (result.status !== 'ok') {
        throw new Error(`Artifact publishing: ${result.status}`)
      }
      reference = { shareUrl: result.value.item.shareUrl }
    }
    await writeChanged(
      join(dirname(rendered.path), 'plan-view.publish.json'),
      JSON.stringify(
        {
          sourceKey,
          planVersion: rendered.planVersion,
          revision: rendered.revision,
          contentHash: rendered.contentHash,
          reference
        },
        null,
        2
      )
    )
    return { ...rendered, reference }
  })
}

export const WORK_PLAN_VIEW_METHODS: readonly RpcMethod[] = (
  ['render', 'open', 'publish'] as const
).map((operation) =>
  defineMethod({
    name: `workPlan.${operation}`,
    params: Params,
    handler: (params, context) => execute(params, context, operation)
  })
)
