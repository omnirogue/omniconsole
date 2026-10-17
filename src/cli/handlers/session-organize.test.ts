import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../args'
import type { RuntimeClient } from '../runtime-client'
import type { SessionOrganizeResult } from '../../shared/session-organize'
import {
  formatOrganizeResult,
  parseOrganizePlan,
  SESSION_ORGANIZE_HANDLERS
} from './session-organize'

const FOCUS = {
  lines: 2,
  budget: 5,
  needsYou: 1,
  folders: ['OmniRogue'],
  folded: [],
  everythingElse: { sessions: 0, folders: 0 }
}

function result(patch: Partial<SessionOrganizeResult> = {}): SessionOrganizeResult {
  return {
    dryRun: false,
    actor: { kind: 'cli' },
    folders: [],
    changes: [{ kind: 'hide', panes: ['tab-1:leaf-1'], opId: 'op-1', status: 'applied' }],
    skipped: [],
    focus: { before: FOCUS, after: FOCUS },
    ...patch
  }
}

async function run(argv: string[], answer: SessionOrganizeResult = result()) {
  const parsed = parseArgs(argv)
  const handler = SESSION_ORGANIZE_HANDLERS[parsed.commandPath.join(' ')]!
  const call = vi.fn(async () => ({ result: answer }))
  await handler({
    flags: parsed.flags,
    client: { call, isRemote: false } as unknown as RuntimeClient,
    cwd: '/tmp',
    json: false
  })
  return call.mock.calls[0] as unknown as [string, { plan: unknown; apply: boolean }]
}

describe('omni session tag|hide|snooze', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends one plan for many panes, applied, with the reason once', async () => {
    const [method, params] = await run([
      'session',
      'hide',
      '--pane',
      'tab-1:leaf-1, tab-2:leaf-1',
      '--reason',
      'quiet runs'
    ])
    expect(method).toBe('sessionOrganization.organize')
    expect(params).toEqual({
      apply: true,
      plan: {
        reason: 'quiet runs',
        changes: [
          { pane: 'tab-1:leaf-1', hide: true },
          { pane: 'tab-2:leaf-1', hide: true }
        ]
      }
    })
  })

  it('tags with --add and --remove, and a dry run does not apply', async () => {
    const [, params] = await run([
      'session',
      'tag',
      '--pane',
      'tab-1:leaf-1',
      '--add',
      'OmniRogue,ACME',
      '--remove',
      'BetaCorp',
      '--dry-run'
    ])
    expect(params).toEqual({
      apply: false,
      plan: {
        changes: [
          { pane: 'tab-1:leaf-1', addTags: ['OmniRogue', 'ACME'], removeTags: ['BetaCorp'] }
        ]
      }
    })
  })

  it('snoozes until a parsed time, and fails when nothing was applied', async () => {
    const [, params] = await run([
      'session',
      'snooze',
      '--pane',
      'tab-1:leaf-1',
      '--until',
      '+2h',
      '--reason',
      'CI'
    ])
    const snooze = (params.plan as { changes: { snooze: number }[] }).changes[0]!.snooze
    expect(snooze).toBeGreaterThan(Date.now() + 2 * 3_600_000 - 60_000)
    await expect(
      run(
        ['session', 'hide', '--pane', 'tab-1:leaf-1', '--reason', 'r'],
        result({
          changes: [],
          skipped: [{ pane: 'tab-1:leaf-1', kind: 'hide', reason: 'It is asking you something.' }]
        })
      )
    ).rejects.toThrow('Nothing changed: It is asking you something.')
  })
})

describe('omni session organize', () => {
  it('reads a plan, turning snooze words into times, and refuses an invalid one', () => {
    const plan = parseOrganizePlan(
      JSON.stringify({
        reason: 'tidy',
        changes: [
          { pane: 'a', folder: 'OmniRogue / Checkout', snooze: '+1d' },
          { pane: 'b', snooze: null, archive: true }
        ]
      })
    )
    expect(plan.changes[0]!.snooze).toBeGreaterThan(Date.now())
    expect(plan.changes[1]).toEqual({ pane: 'b', snooze: null, archive: true })
    expect(() => parseOrganizePlan('{"changes":[{"pane":"a","hide":"yes"}]}')).toThrow(
      /not valid at changes.0.hide/
    )
    expect(() => parseOrganizePlan('not json')).toThrow(/not JSON/)
  })

  it('prints the grouped changes, skips and the five-line budget', () => {
    const text = formatOrganizeResult(
      result({
        dryRun: true,
        changes: [{ kind: 'move', panes: ['a', 'b'], status: 'planned' }],
        skipped: [
          { pane: 'c', kind: 'entry', reason: 'No conversation in the sidebar has pane c.' }
        ]
      })
    )
    expect(text).toContain('Dry run — nothing changed.')
    expect(text).toContain('planned move: 2 sessions')
    expect(text).toContain('skipped c (entry): No conversation in the sidebar has pane c.')
    expect(text).toContain('Sidebar after: 2 of 5 lines — Needs you · 1 | OmniRogue')
  })
})
