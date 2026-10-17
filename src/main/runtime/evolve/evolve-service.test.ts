import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EvolveRunRecord, EvolveStartRequest } from '../../../shared/evolve-workflow'
import { evolveChangedEvent } from '../../../shared/evolve-workflow-status'
import { createFakeEvolveHost, FAKE_LEDGER_RUN_ID } from './evolve-fake-host.test-fixtures'
import { EvolveRunStore } from './evolve-run-store'
import { EvolveService } from './evolve-service'

const posix = process.platform === 'win32' ? describe.skip : describe

function setup(options: Parameters<typeof createFakeEvolveHost>[0] = {}) {
  const host = createFakeEvolveHost(options)
  const directory = mkdtempSync(join(tmpdir(), 'evolve-runs-'))
  const notified: EvolveRunRecord[] = []
  const deps = {
    store: new EvolveRunStore(directory),
    notify: (record: EvolveRunRecord) => notified.push(record),
    run: host.run,
    place: async () => host.placement,
    localIdentity: () => 'cloud@mw0003',
    pollMs: 50,
    lostAfterMs: 300
  }
  const service = new EvolveService(deps)
  const request: EvolveStartRequest = {
    target: 'email-smoke',
    checkout: host.checkout,
    iterations: 3,
    seedFrom: 'email-replies-smoke',
    runsOn: 'fleet',
    runsOnHost: 'mw0001',
    conversationId: 'tab-1'
  }
  return { host, directory, deps, service, request, notified }
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

posix('EvolveService on a fleet host', () => {
  it('submits, starts one detached worker and follows the ledger to done', async () => {
    const { host, service, request, notified } = setup()
    const started = await service.start(request, { agent: false })
    expect(started).toMatchObject({
      state: 'starting',
      host: 'mw0001',
      submittedBy: 'cloud@mw0003'
    })
    const run = await until(service, started.id, (current) => current.state === 'done')
    expect(run.ledgerRunId).toBe(FAKE_LEDGER_RUN_ID)
    expect(run.submitted).toMatchObject({ iterations: 3, seedFrom: 'email-replies-smoke' })
    expect(run.worker?.directory).toBe(join(host.home, '.omni-fleet/evolve-runs', run.id))
    expect(run.ledger?.seeded?.[0]).toMatchObject({
      source_run_id: 'r1',
      prior_combined_score: 0.75
    })
    expect(run.ledger?.summary?.best_combined_score).toBe(0.8)
    const calls = readFileSync(join(host.state, 'calls'), 'utf8')
    expect(calls).toContain(
      'submit jevlab/evolve/email/smoke.yaml --submitted-by cloud@mw0003 --json --iterations 3 --seed-from email-replies-smoke'
    )
    expect(calls).toContain(`worker --host mw0001 --run-id ${FAKE_LEDGER_RUN_ID}`)
    expect(evolveChangedEvent(notified.at(-1)!)).toMatchObject({
      conversationId: 'tab-1',
      executionId: run.id,
      preset: 'evolve',
      state: 'completed',
      host: 'mw0001',
      completed: 2,
      total: 3
    })
  })

  it('refuses by name before anything is written when Claude is not signed in on the host', async () => {
    const { service, request, directory } = setup({ claudeLoggedIn: false })
    await expect(service.start(request, { agent: false })).rejects.toThrow(
      'Claude is not signed in on mw0001 (claude auth status reports no login over SSH). Evolve drafts with claude -p there, so it cannot run on mw0001.'
    )
    expect(service.list()).toEqual([])
    expect(readdirSync(directory)).toEqual([])
  })

  it('refuses a host without the Evolve checkout', async () => {
    const { service, request } = setup()
    await expect(
      service.start({ ...request, checkout: '~/Repos/nowhere' }, { agent: false })
    ).rejects.toThrow('mw0001 has no jev-lab checkout at ~/Repos/nowhere')
  })

  it('submits an agent-started run as the person who asked', async () => {
    const { service, request } = setup()
    const run = await service.start(
      { ...request, requestedBy: 'Sal', request: 'run the smoke on mw0001' },
      { agent: true }
    )
    expect(run.submittedBy).toBe('Sal')
    await until(service, run.id, (current) => current.state === 'done')
  })

  it('fails by name when the worker exits without settling its ledger run', async () => {
    const { host, service, request } = setup()
    writeFileSync(join(host.state, 'die'), '')
    const started = await service.start(request, { agent: false })
    const run = await until(service, started.id, (current) => current.state === 'failed')
    expect(run.contact?.verdict).toBe('exited')
    expect(run.error).toContain(
      `The worker on mw0001 exited without settling ledger run ${FAKE_LEDGER_RUN_ID} (the ledger still says running)`
    )
  })

  it('stops the worker: it settles the ledger run failed and the record reads stopped', async () => {
    const { service, request } = setup({ workerSeconds: 30 })
    const started = await service.start(request, { agent: false })
    await until(service, started.id, (current) => current.ledger?.status === 'running')
    const stopping = await service.stop(started.id)
    expect(stopping.stopRequestedAt).toBeTruthy()
    const run = await until(service, started.id, (current) => current.state === 'stopped')
    expect(run.error).toBe('Stopped on request; the ledger recorded the run failed.')
  })

  it('reads a lost host as unverifiable, never exited, and follows again once it answers', async () => {
    const { host, service, request } = setup({ workerSeconds: 1.5 })
    const started = await service.start(request, { agent: false })
    await until(service, started.id, (current) => current.ledger?.status === 'running')
    host.setReachable(false)
    const lost = await until(service, started.id, (current) => current.state === 'unverifiable')
    expect(lost.contact?.verdict).toBe('unverifiable')
    expect(lost.contact?.detail).toContain('Operation timed out')
    host.setReachable(true)
    await service.refresh(started.id)
    const run = await until(service, started.id, (current) => current.state === 'done')
    expect(run.events.map((event) => event.text)).toContain(
      'Contact with mw0001 is back; following again.'
    )
  })

  it('resumes following a running run after a restart', async () => {
    const { deps, service, request } = setup({ workerSeconds: 1 })
    const started = await service.start(request, { agent: false })
    await until(service, started.id, (current) => current.state === 'running')
    const restarted = new EvolveService(deps)
    const run = await until(restarted, started.id, (current) => current.state === 'done')
    expect(run.ledgerRunId).toBe(FAKE_LEDGER_RUN_ID)
  })
})
