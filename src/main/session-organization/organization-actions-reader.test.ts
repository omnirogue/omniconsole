import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSessionActions } from './organization-actions-reader'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'organization-actions-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const organize = (phase: string, ts: string) => ({
  ts,
  actor: { paneKey: 'tab-9:leaf-9', title: 'Steward' },
  action: 'session.move',
  target: {},
  summary: 'move: 100 targets',
  reason: 'keep within five',
  opId: 'organize-1',
  phase,
  executor: { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Steward' },
  organization: {
    kind: 'move',
    targets: Array.from({ length: 100 }, (_, index) => ({ sessionKey: `s${index}` })),
    value: 'f1'
  }
})

describe('readSessionActions', () => {
  it('reads the rotated and current trail newest first, one line per organization change', async () => {
    const path = join(dir, 'session-actions.jsonl')
    writeFileSync(
      `${path}.1`,
      `${JSON.stringify({ ts: '2026-09-25T08:00:00.000Z', actor: 'cli', action: 'stop', target: { paneKey: 'p' }, summary: 'Stopped “A”' })}\n`
    )
    writeFileSync(
      path,
      [
        JSON.stringify(organize('prepared', '2026-09-25T09:00:00.000Z')),
        '{"torn',
        JSON.stringify(organize('applied', '2026-09-25T09:00:01.000Z')),
        JSON.stringify({
          ts: '2026-09-24T09:00:00.000Z',
          actor: 'cli',
          action: 'ask',
          target: {},
          summary: 'old'
        })
      ].join('\n')
    )
    const all = await readSessionActions(path, {
      since: Date.parse('2026-09-25T00:00:00Z'),
      limit: 50
    })
    expect(all.map((line) => [line.action, line.phase ?? null])).toEqual([
      ['session.move', 'applied'],
      ['stop', null]
    ])
    expect(all[0]!.organization?.targets).toHaveLength(100)
    const byAgent = await readSessionActions(path, {
      since: 0,
      actors: ['pane'],
      kinds: ['move'],
      limit: 50
    })
    expect(byAgent.map((line) => line.opId)).toEqual(['organize-1'])
    const byCli = await readSessionActions(path, {
      since: 0,
      actors: ['cli'],
      kinds: ['ask'],
      limit: 50
    })
    expect(byCli.map((line) => line.summary)).toEqual(['old'])
  })

  it('answers nothing, not an error, when no trail exists yet', async () => {
    await expect(
      readSessionActions(join(dir, 'none.jsonl'), { since: 0, limit: 5 })
    ).resolves.toEqual([])
  })
})
