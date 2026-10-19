import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import { parseAgentSessionOperationTimestamp } from '../../../shared/agent-session-host-authority'
import { workflowEvidenceDigest } from './workflow-evidence-digest'
import {
  deliverDiscoverToOmnios,
  discoverOmniosEnabled,
  discoverOmniosStatus,
  scheduleDiscoverToOmnios,
  type DiscoverOmniosDelivery
} from './discover-omnios-delivery'

import { reconcileDiscoverDeliveries } from './discover-omnios-reconcile'
import { discoverOutbox } from './discover-omnios-outbox'

const roots: string[] = []
const databases: Database.Database[] = []
afterEach(async () => {
  databases.splice(0).forEach((db) => db.close())
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function dbWith(snapshot: unknown, path = ':memory:'): Database.Database {
  const db = new Database(path)
  databases.push(db)
  db.exec(
    'CREATE TABLE local_workflow_executions(id TEXT PRIMARY KEY, state TEXT, snapshot_json TEXT, snapshot_digest TEXT)'
  )
  const snapshotJson = JSON.stringify({ snapshot })
  db.prepare('INSERT INTO local_workflow_executions VALUES (?,?,?,?)').run(
    'run-1',
    'completed',
    snapshotJson,
    workflowEvidenceDigest(snapshotJson)
  )
  return db
}

function snapshot(template = 'discover', host: Record<string, unknown> = {}) {
  return {
    task: { prompt: ' Find what slows checkout ', evidence: '' },
    graph: { spec: { template, steps: [] }, agentSeats: {} },
    host: { workspaceId: 'repo::/work/shop', conversationId: 'conversation-1', ...host }
  }
}

const view = {
  executionId: 'run-1',
  state: 'completed',
  prompt: 'Find what slows checkout',
  startedAt: 0,
  finishedAt: 120_000,
  calls: [],
  result: { markdown: 'Two things slow checkout. Start with the wallet button.' },
  graphRun: {
    spec: { template: 'discover', steps: [] },
    steps: [],
    ranking: []
  }
} as unknown as LocalWorkflowView

type Launch = { clientOperationId: string }

async function deps(
  template?: string,
  host?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {}
): Promise<DiscoverOmniosDelivery & { launches: Launch[] }> {
  const root = await mkdtemp(join(tmpdir(), 'discover-omnios-'))
  roots.push(root)
  const launches: Launch[] = []
  return {
    db: dbWith(snapshot(template, host), join(root, 'journal.db')),
    view: async () => view,
    root,
    env,
    launches,
    runtime: {
      agentLaunchReadiness: vi.fn(async () => ({
        runtimeId: 'runtime-1',
        workspace: {
          id: 'repo::/work/shop',
          hostId: 'local',
          kind: 'git',
          path: '/work/shop',
          name: null
        }
      })),
      createAgentSession: vi.fn(async (request: Launch) => {
        // As the runtime does: any other operation id is refused before anything starts.
        if (parseAgentSessionOperationTimestamp(request.clientOperationId) === null) {
          throw new Error('agent_session_operation_invalid')
        }
        launches.push(request)
        return { terminal: { handle: 'term-1', paneKey: 'pane-1' }, disposition: 'created' }
      })
    } as unknown as DiscoverOmniosDelivery['runtime']
  }
}

const marker = async (d: DiscoverOmniosDelivery) =>
  JSON.parse(await readFile(join(d.root, 'run-1', 'launch.json'), 'utf8'))

describe('bringing a finished Discover run to OmniOS', () => {
  it('writes the page beside the run and starts one Sonnet session to publish it, once', async () => {
    const source = { commit: 'a'.repeat(40), branch: 'main-next', dirty: false }
    const d = await deps('discover', { discoverSource: source })
    const outcome = await deliverDiscoverToOmnios(d, 'run-1')
    expect(outcome).toEqual({
      outcome: 'launched',
      folder: join(d.root, 'run-1'),
      paneKey: 'pane-1'
    })
    expect(d.launches).toHaveLength(1)
    expect(d.launches[0]).toMatchObject({
      clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
      worktree: 'id:repo::/work/shop',
      agent: 'claude',
      promptDelivery: 'auto-submit',
      presentation: 'background',
      launchPreferences: { model: 'sonnet', effort: 'medium' },
      sshAccountSelection: {
        policy: 'best-verified',
        expectedHostId: 'local',
        expectedRuntimeId: 'runtime-1'
      }
    })
    const folder = join(d.root, 'run-1')
    const page = await readFile(join(folder, 'page.html'), 'utf8')
    expect(page).toContain('Two things slow checkout.')
    expect(page).toContain('Discover · shop · 2 min')
    expect(JSON.parse(await readFile(join(folder, 'findings.json'), 'utf8')).goal).toBe(
      'Find what slows checkout'
    )
    expect(JSON.parse(await readFile(join(folder, 'findings.json'), 'utf8'))).toMatchObject({
      source,
      executionId: 'run-1',
      workspaceId: 'repo::/work/shop'
    })
    expect((await stat(join(folder, 'close.sh'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(folder, 'publish.sh'))).mode & 0o777).toBe(0o700)
    expect(await marker(d)).toMatchObject({
      state: 'launched',
      paneKey: 'pane-1',
      attempts: 1,
      operationId: d.launches[0].clientOperationId
    })
    // A second notice for the same run starts nothing.
    expect(await deliverDiscoverToOmnios(d, 'run-1')).toMatchObject({ outcome: 'pending' })
    expect(d.launches).toHaveLength(1)
  })

  it('leaves other templates, isolated runs and a switched-off computer alone', async () => {
    const council = await deps('council')
    expect(await deliverDiscoverToOmnios(council, 'run-1')).toEqual({
      outcome: 'skipped',
      reason: 'not a Discover run'
    })
    const isolated = await deps('discover', { isolated: true })
    expect((await deliverDiscoverToOmnios(isolated, 'run-1')).outcome).toBe('skipped')
    const off = await deps('quick-discover', {}, { OMNI_DISCOVER_OMNIOS: '0' })
    expect(await deliverDiscoverToOmnios(off, 'run-1')).toEqual({
      outcome: 'skipped',
      reason: 'OMNI_DISCOVER_OMNIOS is off'
    })
    expect([...council.launches, ...isolated.launches, ...off.launches]).toEqual([])
  })

  it('tries a refused start again under the same operation id', async () => {
    const d = await deps()
    vi.mocked(d.runtime.createAgentSession).mockRejectedValueOnce(new Error('no account with room'))
    expect(await deliverDiscoverToOmnios(d, 'run-1')).toEqual({
      outcome: 'failed',
      folder: join(d.root, 'run-1'),
      reason: 'no account with room'
    })
    const refused = await marker(d)
    expect(refused).toMatchObject({ state: 'failed', error: 'no account with room', attempts: 1 })
    expect((await deliverDiscoverToOmnios(d, 'run-1')).outcome).toBe('launched')
    expect(d.launches.map((launch) => launch.clientOperationId)).toEqual([refused.operationId])
    expect(await marker(d)).toMatchObject({ state: 'launched', attempts: 2 })
  })

  it('never starts again after a start whose outcome is unknown', async () => {
    const d = await deps()
    const lost = Object.assign(new Error('the launch answer was lost'), {
      agentSessionOperationOutcome: 'unknown'
    })
    vi.mocked(d.runtime.createAgentSession).mockRejectedValueOnce(lost)
    expect((await deliverDiscoverToOmnios(d, 'run-1')).outcome).toBe('unknown')
    expect(await deliverDiscoverToOmnios(d, 'run-1')).toEqual({
      outcome: 'skipped',
      reason: 'already unknown'
    })
    expect(d.launches).toEqual([])
  })

  it('starts one session when two notices arrive together', async () => {
    const d = await deps()
    const outcomes = await Promise.all([
      deliverDiscoverToOmnios(d, 'run-1'),
      deliverDiscoverToOmnios(d, 'run-1')
    ])
    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(['launched', 'skipped'])
    expect(d.launches).toHaveLength(1)
  })

  it('retries a refused start after each delay, then stops', async () => {
    const d = await deps()
    vi.mocked(d.runtime.createAgentSession).mockRejectedValue(new Error('window not ready'))
    expect((await scheduleDiscoverToOmnios(d, 'run-1', [1, 1])).outcome).toBe('failed')
    await vi.waitFor(async () => expect((await marker(d)).attempts).toBe(3))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(vi.mocked(d.runtime.createAgentSession)).toHaveBeenCalledTimes(3)
  })

  it('reports where the page stands for omni workflow status', async () => {
    const d = await deps()
    expect(discoverOmniosStatus(d.root, 'run-1')).toBeUndefined()
    await deliverDiscoverToOmnios(d, 'run-1')
    expect(discoverOmniosStatus(d.root, 'run-1')).toEqual({
      state: 'pending',
      at: expect.any(String),
      attempts: 1
    })
    const reply = { ok: true, result: { shareUrl: 'https://app.omnisi.ai/a/1a2b3c' } }
    await writeFile(join(d.root, 'run-1', 'published.json'), JSON.stringify(reply))
    expect(discoverOmniosStatus(d.root, 'run-1')?.url).toBe('https://app.omnisi.ai/a/1a2b3c')
    await writeFile(
      join(d.root, 'run-1', 'published.json'),
      JSON.stringify({ result: { shareUrl: 'javascript:alert(1)' } })
    )
    expect(discoverOmniosStatus(d.root, 'run-1')?.url).toBeUndefined()
  })

  it('never publishes a benchmark budget root, including on restart recovery', async () => {
    const d = await deps()
    const json = JSON.stringify({
      snapshot: {
        ...snapshot(),
        budget: {
          rootId: '11111111-1111-4111-8111-111111111111',
          benchmark: true,
          maxInputTokens: 1,
          maxOutputTokens: 1
        }
      }
    })
    d.db
      .prepare('UPDATE local_workflow_executions SET snapshot_json=?, snapshot_digest=? WHERE id=?')
      .run(json, workflowEvidenceDigest(json), 'run-1')
    expect(await deliverDiscoverToOmnios(d, 'run-1')).toEqual({
      outcome: 'skipped',
      reason: 'a benchmark budget root'
    })
    await reconcileDiscoverDeliveries({ ...d, view: async () => view })
    await reconcileDiscoverDeliveries({ ...d, view: async () => view })
    expect(d.launches).toEqual([])
    expect(discoverOutbox(d.db).read('run-1')).toBeFalsy()
  })

  it('recovers completed CLI runs after restart without following or rerunning them', async () => {
    const d = await deps()
    await reconcileDiscoverDeliveries({ ...d, view: async () => view })
    expect(d.launches).toHaveLength(1)
    expect(discoverOutbox(d.db).read('run-1')?.state).toBe('launched')
    await rm(join(d.root, 'run-1', 'launch.json'))
    // The database record survives a missing mirror file and prevents a duplicate publisher.
    await reconcileDiscoverDeliveries({ ...d, view: async () => view })
    expect(d.launches).toHaveLength(1)
    expect((await deliverDiscoverToOmnios(d, 'run-1')).outcome).toBe('pending')
    const url = 'https://app.omnisi.ai/a/published'
    await writeFile(
      join(d.root, 'run-1', 'published.json'),
      JSON.stringify({ ok: true, result: { shareUrl: url } })
    )
    expect(await deliverDiscoverToOmnios(d, 'run-1')).toMatchObject({ outcome: 'published', url })
    expect(discoverOmniosStatus(d.root, 'run-1')).toMatchObject({ state: 'published', url })
  })

  it('keeps a refused delivery durable across restart and honors the persisted retry time', async () => {
    const d = await deps()
    vi.mocked(d.runtime.createAgentSession).mockRejectedValueOnce(new Error('not ready'))
    await deliverDiscoverToOmnios(d, 'run-1')
    const before = discoverOutbox(d.db).read('run-1')!
    databases.splice(databases.indexOf(d.db), 1)
    d.db.close()
    d.db = new Database(join(d.root, 'journal.db'))
    databases.push(d.db)
    expect(discoverOutbox(d.db).read('run-1')).toEqual(before)
    discoverOutbox(d.db).defer('run-1', Date.now() + 60_000)
    await reconcileDiscoverDeliveries({ ...d, view: async () => view })
    expect(d.launches).toHaveLength(0)
    discoverOutbox(d.db).defer('run-1', 0)
    await reconcileDiscoverDeliveries({ ...d, view: async () => view })
    expect(d.launches[0].clientOperationId).toBe(before.operationId)
  })

  it('uses a verified Codex publisher only after a definite Claude readiness refusal', async () => {
    const d = await deps()
    const ready = await d.runtime.agentLaunchReadiness({
      worktree: 'id:repo::/work/shop',
      agent: 'claude',
      preview: true
    })
    vi.mocked(d.runtime.agentLaunchReadiness)
      .mockResolvedValueOnce({
        ...ready,
        account: { verified: false, refusal: 'signed out', accounts: [] }
      })
      .mockResolvedValueOnce({ ...ready, account: { verified: true, receipt: {} as never } })
    await deliverDiscoverToOmnios(d, 'run-1')
    expect(d.launches[0]).toMatchObject({ agent: 'codex', launchPreferences: { effort: 'medium' } })
    expect(await marker(d)).toMatchObject({ desk: 'codex' })
  })

  it('can choose a verified alternate after a restart with neither publisher initially ready', async () => {
    const d = await deps()
    const ready = await d.runtime.agentLaunchReadiness({
      worktree: 'id:repo::/work/shop',
      agent: 'claude',
      preview: true
    })
    const refused = {
      ...ready,
      account: { verified: false as const, refusal: 'not ready', accounts: [] }
    }
    vi.mocked(d.runtime.agentLaunchReadiness)
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce({ ...ready, account: { verified: true, receipt: {} as never } })
    expect((await deliverDiscoverToOmnios(d, 'run-1')).outcome).toBe('failed')
    expect(await marker(d)).toMatchObject({ state: 'prepared' })
    expect((await deliverDiscoverToOmnios(d, 'run-1')).outcome).toBe('launched')
    expect(d.launches).toHaveLength(1)
    expect(d.launches[0]).toMatchObject({ agent: 'codex' })
  })

  it('never treats an unsuccessful publish reply or an unfinished run as delivered', async () => {
    const d = await deps()
    d.view = async () => ({ ...view, state: 'running' })
    expect((await deliverDiscoverToOmnios(d, 'run-1')).outcome).toBe('skipped')
    expect(d.launches).toHaveLength(0)
    d.view = async () => view
    await deliverDiscoverToOmnios(d, 'run-1')
    await writeFile(
      join(d.root, 'run-1', 'published.json'),
      JSON.stringify({ ok: false, result: { shareUrl: 'https://example.com' } })
    )
    expect((await deliverDiscoverToOmnios(d, 'run-1')).outcome).toBe('pending')
  })

  it('recovers a crash during preparation, but protects an uncertain in-flight launch', async () => {
    const d = await deps()
    const box = discoverOutbox(d.db)
    box.enqueue('run-1')
    expect(discoverOmniosStatus(d.root, 'run-1', d.db)).toEqual({ state: 'pending' })
    const operationId = `${Date.now()}-${'b'.repeat(32)}`
    box.write('run-1', {
      state: 'prepared',
      at: new Date().toISOString(),
      operationId,
      attempts: 1
    })
    expect((await deliverDiscoverToOmnios(d, 'run-1')).outcome).toBe('launched')
    expect(d.launches[0].clientOperationId).toBe(operationId)
    box.write('run-1', {
      state: 'launching',
      at: new Date().toISOString(),
      operationId,
      attempts: 2
    })
    await reconcileDiscoverDeliveries({ ...d, view: async () => view })
    expect(d.launches).toHaveLength(1)
  })

  it('is on unless the switch says off', () => {
    expect(discoverOmniosEnabled({})).toBe(true)
    expect(discoverOmniosEnabled({ OMNI_DISCOVER_OMNIOS: '1' })).toBe(true)
    for (const off of ['0', 'false', 'OFF', 'no']) {
      expect(discoverOmniosEnabled({ OMNI_DISCOVER_OMNIOS: off })).toBe(false)
    }
  })
})
