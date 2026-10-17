import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionSearchEngine } from './session-search-engine'
import { discoverTranscriptRoots } from './session-search-roots'
import type { SessionSearchServiceSearchValue } from './session-search-service-protocol'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    await dispose()
  }
})

describe('shared transcript search engine', () => {
  it('indexes an execution-host transcript with existing redaction and closes cleanly', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'ssh-search-engine-')))
    cleanup.push(() => rm(home, { recursive: true, force: true }))
    const project = join(home, '.claude', 'projects', 'project')
    await mkdir(project, { recursive: true })
    const transcript = join(project, '4caf72e4-10b8-4bea-a01d-6878aa1201a1.jsonl')
    const fakeToken = `sk-or-v1-${'a'.repeat(40)}`
    await writeFile(
      transcript,
      `${JSON.stringify({
        type: 'user',
        timestamp: new Date().toISOString(),
        cwd: '/execution/workspace',
        message: { content: `Investigate heliotrope dispatch with token ${fakeToken}` }
      })}\n`
    )
    const engine = createSessionSearchEngine({
      type: 'init',
      protocol: 1,
      dbPath: join(home, 'index.sqlite'),
      modelDir: join(home, 'missing-model'),
      homeDir: home,
      appDataDirs: [],
      hostLabel: 'execution-host',
      dutyCycle: 1,
      passIntervalMs: 90_000
    })
    cleanup.push(async () => engine.shutdown())
    const read = () =>
      engine.execute({
        type: 'request',
        id: 1,
        op: 'search',
        query: 'heliotrope',
        limit: 3
      }) as SessionSearchServiceSearchValue
    await vi.waitFor(() => expect(read().passes).toBe(1), { timeout: 5_000 })
    const result = read()
    expect(result.indexedSessions).toBe(1)
    expect(result.pendingFiles).toBe(0)
    expect(result.hits[0]).toMatchObject({
      executionHostId: 'local',
      hostLabel: 'execution-host',
      transcriptPath: transcript
    })
    expect(JSON.stringify(result)).not.toContain(fakeToken)
    engine.shutdown()
  })

  it('finds a chat-only session by the Outcome and Links of its model summary', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'ssh-search-outcome-')))
    cleanup.push(() => rm(home, { recursive: true, force: true }))
    const project = join(home, '.claude', 'projects', 'project')
    await mkdir(project, { recursive: true })
    const at = new Date().toISOString()
    await writeFile(
      join(project, '5bdf83f5-21c9-4c5b-b12d-7989bb2312b2.jsonl'),
      [
        { type: 'user', message: { content: 'Why did the cost per click jump last week?' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'It was the auction.' }] } }
      ]
        .map((line) => `${JSON.stringify({ ...line, timestamp: at, cwd: '/w' })}\n`)
        .join('')
    )
    const engine = createSessionSearchEngine({
      type: 'init',
      protocol: 1,
      dbPath: join(home, 'index.sqlite'),
      modelDir: join(home, 'missing-model'),
      homeDir: home,
      appDataDirs: [],
      hostLabel: 'this computer',
      dutyCycle: 1,
      passIntervalMs: 90_000
    })
    cleanup.push(async () => engine.shutdown())
    const search = (query: string) =>
      engine.execute({
        type: 'request',
        id: 1,
        op: 'search',
        query,
        limit: 3
      }) as SessionSearchServiceSearchValue
    await vi.waitFor(() => expect(search('auction').passes).toBe(1), { timeout: 5_000 })
    const sessionKey = search('auction').hits[0]!.sessionKey
    expect(search('marmalade').hits).toEqual([])
    expect(
      engine.execute({
        type: 'request',
        id: 2,
        op: 'saveModelSummary',
        sessionKey,
        basisBytes: 10_000,
        summary: [
          'Title: Cost per click jump explained',
          'Goal: Explain the cost per click jump',
          'State: Answered in chat',
          'Keywords: CPC, Meta',
          'Outcome: The marmalade audience overlap raised CPC 18%;',
          'Sal chose to hold budgets.',
          'Links: ~/Work/Ops/Projects/Quince-Audit/report.md'
        ].join('\n')
      })
    ).toBe(true)
    const byOutcome = search('marmalade').hits
    expect(byOutcome.map((hit) => hit.sessionKey)).toEqual([sessionKey])
    expect(byOutcome[0]!.reasons).toContain('summary matches')
    expect(byOutcome[0]!.summary).toContain(
      'Outcome: The marmalade audience overlap raised CPC 18%; Sal chose to hold budgets.'
    )
    expect(search('Quince-Audit').hits.map((hit) => hit.sessionKey)).toEqual([sessionKey])
  })

  it('includes pooled Codex transcript homes without reading account credentials or backups', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'ssh-search-roots-')))
    cleanup.push(() => rm(home, { recursive: true, force: true }))
    const profile = join(home, '.codex-accounts', 'worker', 'sessions')
    const backup = join(home, '.codex-accounts', 'backups', 'sessions')
    await mkdir(profile, { recursive: true })
    await mkdir(backup, { recursive: true })
    const roots = await discoverTranscriptRoots({ homeDir: home, appDataDirs: [] })
    expect(roots).toContainEqual({ agent: 'codex', dir: profile })
    expect(roots.some((root) => root.dir === backup)).toBe(false)
  })
})
