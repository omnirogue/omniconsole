import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { EvolveRunRecord, EvolveStartRequest } from '../../../shared/evolve-workflow'
import { EvolveRunStore } from './evolve-run-store'
import { EvolveService } from './evolve-service'

const CLOUD_RUN_ID = 'run-cloud-1'
const request: EvolveStartRequest = { target: 'email-smoke', runsOn: 'hosted', iterations: 3 }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function setup(replies: { start?: () => Response; poll?: () => Response } = {}) {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    if (init?.method === 'POST' && path === '/api/evolve/runs') {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return replies.start
        ? replies.start()
        : json(201, {
            run_id: CLOUD_RUN_ID,
            status: 'queued',
            spec_sha: 'sha',
            target: 'email-smoke'
          })
    }
    if (path === `/api/evolve/runs/${CLOUD_RUN_ID}`) {
      return replies.poll ? replies.poll() : json(200, { run_id: CLOUD_RUN_ID, status: 'running' })
    }
    return json(404, { error: 'not_found' })
  })
  const shell = vi.fn()
  const deps = {
    store: new EvolveRunStore(mkdtempSync(join(tmpdir(), 'evolve-hosted-'))),
    notify: () => {},
    run: shell,
    localIdentity: () => 'sal@desk',
    hosted: {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      leaseToken: () => 'or_obp_test',
      baseUrl: 'https://cloud.test',
      readSpecFile: async () =>
        JSON.stringify({ target: 'email-smoke', budget: { max_cost_cents: 5_000 } })
    },
    hostedEventStream: false,
    pollMs: 20,
    lostAfterMs: 100
  }
  return { service: new EvolveService(deps), bodies, shell }
}

async function until(service: EvolveService, id: string, done: (run: EvolveRunRecord) => boolean) {
  for (let i = 0; i < 200; i++) {
    const run = service.show(id)
    if (done(run)) {
      return run
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`run ${id} never reached the state: ${JSON.stringify(service.show(id).events)}`)
}

describe('EvolveService on Omnisi Cloud', () => {
  it("sends the person's cap and lowers a larger spec budget to it", async () => {
    const { service, bodies } = setup()
    const started = await service.start({ ...request, usdCap: 12.5 }, { agent: false })
    const run = await until(service, started.id, (current) => current.state === 'running')
    expect(bodies[0]).toMatchObject({ usd_cap: 12.5, spec: { budget: { max_cost_cents: 1_250 } } })
    expect(run.submitted?.usdCap).toBe(12.5)
  })

  it('sends no usd_cap without one and records the spec budget the cloud holds', async () => {
    const { service, bodies } = setup()
    const started = await service.start(request, { agent: false })
    const run = await until(service, started.id, (current) => current.state === 'running')
    expect(bodies[0]).not.toHaveProperty('usd_cap')
    expect(bodies[0]).toMatchObject({ spec: { budget: { max_cost_cents: 5_000 } } })
    expect(run.submitted?.usdCap).toBe(50)
  })

  it('refuses to stop a hosted run instead of running a shell on this computer', async () => {
    const { service, shell } = setup()
    const started = await service.start(request, { agent: false })
    await until(service, started.id, (current) => current.state === 'running')
    await expect(service.stop(started.id)).rejects.toThrow(
      `Omnisi Cloud has no stop for hosted runs yet, so run ${CLOUD_RUN_ID} goes on there`
    )
    expect(shell).not.toHaveBeenCalled()
    expect(service.show(started.id).stopRequestedAt).toBeUndefined()
  })

  it('reads a start the cloud never answered as unverifiable, never failed', async () => {
    const { service } = setup({
      start: () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError'
        })
      }
    })
    const started = await service.start(request, { agent: false })
    const run = await until(service, started.id, (current) => current.state !== 'starting')
    expect(run.state).toBe('unverifiable')
    expect(run.contact?.verdict).toBe('unverifiable')
    expect(run.error).toBeUndefined()
    expect(run.events.at(-1)?.text).toContain('The run may have started there')
  })

  it('fails a start the cloud refused', async () => {
    const { service } = setup({ start: () => json(429, { error: 'budget_exhausted' }) })
    const started = await service.start(request, { agent: false })
    const run = await until(service, started.id, (current) => current.state !== 'starting')
    expect(run.state).toBe('failed')
    expect(run.error).toContain('budget_exhausted')
  })

  it('follows a hosted run again once the cloud answers after contact was lost', async () => {
    let reachable = true
    let status = 'running'
    const { service } = setup({
      poll: () => {
        if (!reachable) {
          throw new Error('socket hang up')
        }
        return json(200, { run_id: CLOUD_RUN_ID, status })
      }
    })
    const started = await service.start(request, { agent: false })
    await until(service, started.id, (current) => current.state === 'running')
    reachable = false
    await until(service, started.id, (current) => current.state === 'unverifiable')
    reachable = true
    expect((await service.refresh(started.id)).state).toBe('running')
    status = 'succeeded'
    const run = await until(service, started.id, (current) => current.state === 'done')
    expect(run.events.map((event) => event.text)).toContain(
      'Contact with Omnisi Cloud is back; following again.'
    )
  })
})
