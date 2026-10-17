import { describe, expect, it } from 'vitest'
import type { OrganizationRecord } from '../../../../shared/session-organization-change'
import type { StewardResultCard } from '../../../../shared/session-steward-status'
import {
  stewardActivityGroups,
  stewardFinishedView,
  stewardMoveCounts
} from './steward-activity-model'

function record(overrides: Partial<OrganizationRecord>): OrganizationRecord {
  return {
    opId: 'op',
    kind: 'move',
    targets: [{ sessionKey: 's' }],
    value: 'f',
    executor: { kind: 'pane', paneKey: 'tab-9:1', title: 'Steward' },
    phase: 'applied',
    ts: '2026-09-25T10:00:00.000Z',
    ...overrides
  }
}

describe('stewardActivityGroups', () => {
  it('lists a 100-session organize as one change, grouped by the request that asked for it', () => {
    const organize = record({
      opId: 'organize',
      targets: Array.from({ length: 100 }, (_, index) => ({ sessionKey: `s${index}` })),
      request: 'tidy my sidebar',
      ts: '2026-09-25T10:05:00.000Z'
    })
    const rename = record({
      opId: 'rename',
      kind: 'title',
      value: 'Parser fix',
      request: 'tidy my sidebar',
      ts: '2026-09-25T10:06:00.000Z'
    })
    const groups = stewardActivityGroups([organize, rename], new Set(['organize', 'rename']))
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      request: 'tidy my sidebar',
      targetCount: 101,
      undoable: ['rename', 'organize'],
      latestTs: '2026-09-25T10:06:00.000Z'
    })
    expect(groups[0]!.records.map((entry) => entry.opId)).toEqual(['rename', 'organize'])
  })

  it('leaves out the person’s own changes and anything that did not apply', () => {
    const groups = stewardActivityGroups(
      [
        record({ opId: 'mine', executor: { kind: 'person', via: 'sidebar' } }),
        record({ opId: 'broken', phase: 'failed', error: 'no-window' }),
        record({ opId: 'launch', executor: { kind: 'launch', source: 'session-prep' } }),
        record({ opId: 'agent', ts: '2026-09-25T11:00:00.000Z' })
      ],
      new Set(['launch'])
    )
    expect(groups.map((group) => [group.key, group.records.map((entry) => entry.opId)])).toEqual([
      ['run:pane:tab-9:1', ['agent']],
      ['run:launch:session-prep', ['launch']]
    ])
    expect(groups[0]!.undoable).toEqual([])
  })
})

describe('the steward’s own report', () => {
  const card = (key: string, archivedAt: number) =>
    ({ key, builtAt: archivedAt - 5, archivedAt }) as StewardResultCard

  it('puts cards archived since the person last looked first, newest first', () => {
    const view = stewardFinishedView([card('a', 10), card('b', 30), card('c', 20)], 15)
    expect(view.unseen.map((entry) => entry.key)).toEqual(['b', 'c'])
    expect(view.seen.map((entry) => entry.key)).toEqual(['a'])
  })

  it('counts each kind of move', () => {
    expect(
      stewardMoveCounts([
        { at: 1, kind: 'yes', summary: '' },
        { at: 2, kind: 'archive', summary: '' },
        { at: 3, kind: 'archive', summary: '' }
      ])
    ).toEqual({ yes: 1, archive: 2 })
  })
})
