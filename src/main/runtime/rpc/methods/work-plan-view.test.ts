import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcContext } from '../core'
import { ALL_RPC_METHODS } from './index'
import { conversationPlanFixture } from './work-plan-view-fixture'
import { renderWorkPlanView, WORK_PLAN_VIEW_METHODS } from './work-plan-view'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'work-plan-view-'))
  directories.push(directory)
  const chain = conversationPlanFixture(directory)
  const output = join(directory, '.omni', 'runs', chain.id, 's3')
  await mkdir(output, { recursive: true })
  const plan = {
    title: 'A plan',
    summary: 'Do the work',
    steps: [
      { n: 1, title: 'Build', detail: 'Implement it', owner: 'Claude', files: [], dependsOn: [] }
    ]
  }
  await writeFile(join(output, 'plan.json'), JSON.stringify(plan))
  const links = new Map<string, { shareUrl: string }>()
  const runtime = {
    getRuntimeId: () => 'runtime',
    getSessionOutcomeService: () => ({ get: () => chain }),
    getSessionOutcomeExecutionScope: vi.fn(async () => ({ path: directory })),
    openMobileFile: vi.fn(async () => ({ opened: true })),
    getPublishedArtifactLink: vi.fn(async ({ sourceKey }: { sourceKey: string }) => ({
      status: 'ok',
      value: links.get(sourceKey) ?? null
    })),
    publishArtifact: vi.fn(async ({ sourceKey }: { sourceKey: string }) => {
      const item = { shareUrl: `https://example.test/plan-${links.size}` }
      links.set(sourceKey, item)
      return { status: 'ok', value: { change: 'created', item } }
    })
  }
  const context = { runtime } as unknown as RpcContext
  const call = (name: string, params: Record<string, unknown> = { id: 'chain' }) => {
    const method = WORK_PLAN_VIEW_METHODS.find((entry) => entry.name === name)!
    return method.handler(method.params!.parse(params), context)
  }
  return { chain, output, plan, runtime, call }
}

describe('workPlan main methods', () => {
  it('registers render, open and publish in the runtime RPC registry', () => {
    for (const method of WORK_PLAN_VIEW_METHODS) {
      expect(ALL_RPC_METHODS.filter((entry) => entry.name === method.name)).toEqual([method])
    }
  })

  it('does not rewrite identical bytes; changed runtime inputs rewrite the document', async () => {
    const { chain } = await fixture()
    const first = await renderWorkPlanView(chain)
    const before = await stat(first.path)
    const second = await renderWorkPlanView(chain)
    expect(second.contentHash).toBe(first.contentHash)
    expect(second.rewritten).toBe(false)
    expect((await stat(first.path)).mtimeMs).toBe(before.mtimeMs)
    chain.outcomeSet!.attempts[0]!.state = 'completed'
    const changed = await renderWorkPlanView(chain)
    expect(changed.rewritten).toBe(true)
    expect(changed.contentHash).not.toBe(first.contentHash)
  })

  it('renders two running seats and one queued seat from runtime attempts', async () => {
    const { chain } = await fixture()
    const rendered = await renderWorkPlanView(chain)
    const html = await readFile(rendered.path, 'utf8')
    expect(html.match(/class="seat seat-running"/g)).toHaveLength(2)
    expect(html.match(/class="seat seat-queued"/g)).toHaveLength(1)
  })

  it('opens the exact rendered path through the existing document viewer', async () => {
    const { runtime, call } = await fixture()
    await call('workPlan.open')
    expect(runtime.openMobileFile).toHaveBeenCalledWith(
      'id:folder:1',
      '.omni/runs/chain/plan-view.html'
    )
  })

  it('publishes once across concurrent calls and persists the reference', async () => {
    const { chain, runtime, call } = await fixture()
    const first = (await call('workPlan.publish')) as { reference: { shareUrl: string } }
    const second = await call('workPlan.publish')
    expect(second).toMatchObject({ reference: first.reference })
    await Promise.all([call('workPlan.publish'), call('workPlan.publish')])
    expect(runtime.publishArtifact).toHaveBeenCalledTimes(1)
    expect(
      JSON.parse(
        await readFile(join(chain.workspacePath, '.omni/runs/chain/plan-view.publish.json'), 'utf8')
      )
    ).toMatchObject({ reference: first.reference, planVersion: 1, revision: 1 })
    chain.outcomeSet!.attempts[0]!.state = 'completed'
    await call('workPlan.publish')
    expect(runtime.publishArtifact).toHaveBeenCalledTimes(2)
  })

  it('uses the profile-scoped publisher record after the sidecar is lost', async () => {
    const { chain, runtime, call } = await fixture()
    await call('workPlan.publish')
    await rm(join(chain.workspacePath, '.omni/runs/chain/plan-view.publish.json'))
    await call('workPlan.publish')
    expect(runtime.publishArtifact).toHaveBeenCalledTimes(1)
  })

  it('refuses another execution host before reading or publishing local files', async () => {
    const { runtime, call } = await fixture()
    await expect(
      call('workPlan.render', { id: 'chain', expectedExecutionRuntimeId: 'other' })
    ).rejects.toThrow('runtime changed')
    runtime.getSessionOutcomeExecutionScope.mockResolvedValueOnce({ path: '/different' })
    await expect(call('workPlan.publish')).rejects.toThrow('workspace does not match')
    expect(runtime.publishArtifact).not.toHaveBeenCalled()
  })

  it('refuses invalid artifacts and output symlinks', async () => {
    const { chain, output } = await fixture()
    await writeFile(join(output, 'plan.json'), '{}')
    await expect(renderWorkPlanView(chain)).rejects.toThrow()
    const path = join(chain.workspacePath, '.omni/runs/chain/plan-view.html')
    await symlink(join(output, 'plan.json'), path)
    await writeFile(
      join(output, 'plan.json'),
      JSON.stringify({
        title: 'Plan',
        summary: 'summary',
        steps: [{ n: 1, title: 'one', detail: 'detail', owner: 'owner', files: [], dependsOn: [] }]
      })
    )
    await expect(renderWorkPlanView(chain)).rejects.toThrow('symlink')
  })
})
