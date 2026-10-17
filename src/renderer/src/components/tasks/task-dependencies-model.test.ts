import { describe, expect, it } from 'vitest'
import { WorkflowRequestError } from '@/lib/console-workflow-client'
import type { WorkCard } from '../../../../shared/console-work-home-contract'
import {
  dependencyAddRefusal,
  dependencyBadge,
  dependencyBadgeLabel,
  dependencyCandidates,
  dependencyChip,
  dependencyConditionLabel,
  dependencyLinkageComplete,
  taskDependencyRefusalMessage,
  withRestoredDependency,
  withoutDependency
} from './task-dependencies-model'

const card = (id: string, title: string, status = 'ready') => ({ id, title, status }) as WorkCard
const edge = (task_id: string) => ({ task_id, title: task_id, state: 'waiting' as const })

describe('task dependency model', () => {
  it('labels each edge state', () => {
    expect(dependencyChip({ state: 'waiting' })).toMatchObject({ tone: 'muted', label: 'Waiting' })
    expect(dependencyChip({ state: 'satisfied' })).toMatchObject({ tone: 'done', label: 'Done' })
    expect(dependencyChip({ state: 'unmeetable' })).toMatchObject({ tone: 'destructive' })
    expect(dependencyChip({ state: 'missing' })).toMatchObject({ label: 'Missing' })
  })

  it('offers open tasks that are not this task, its prerequisites or its dependents', () => {
    const cards = [
      card('btk_self0001', 'Self'),
      card('btk_up000001', 'Upstream'),
      card('btk_down0001', 'Downstream'),
      card('btk_closed01', 'Closed', 'cancelled'),
      card('btk_free0001', 'Free one'),
      card('btk_free0002', 'Another')
    ]
    const graph = {
      task_id: 'btk_self0001',
      depends_on: [edge('btk_up000001')],
      dependents: [edge('btk_down0001')]
    }
    expect(dependencyCandidates(cards, 'btk_self0001', graph, '').map((c) => c.id)).toEqual([
      'btk_free0001',
      'btk_free0002'
    ])
    expect(dependencyCandidates(cards, 'btk_self0001', graph, 'free').map((c) => c.id)).toEqual([
      'btk_free0001'
    ])
  })

  it('restores a removed edge at its index, once', () => {
    const graph = {
      task_id: 'btk_self0001',
      depends_on: [edge('btk_a0000001'), edge('btk_b0000001')],
      dependents: []
    }
    const without = withoutDependency(graph, 'btk_a0000001')
    const restored = withRestoredDependency(without, edge('btk_a0000001'), 0)
    expect(restored.depends_on?.map((e) => e.task_id)).toEqual(['btk_a0000001', 'btk_b0000001'])
    expect(withRestoredDependency(restored, edge('btk_a0000001'), 0)).toBe(restored)
  })

  it('makes the badge say can’t proceed before waiting, and nothing once all are met', () => {
    expect(dependencyBadge(undefined)).toBeNull()
    expect(dependencyBadge({ waiting: 0, satisfied: 3, unmeetable: 0, missing: 0 })).toBeNull()
    expect(dependencyBadge({ waiting: 2, satisfied: 0, unmeetable: 0, missing: 0 })).toEqual({
      kind: 'waiting',
      count: 2
    })
    expect(dependencyBadge({ waiting: 2, satisfied: 0, unmeetable: 1, missing: 1 })).toEqual({
      kind: 'unmeetable',
      count: 2
    })
  })

  it('says unknown instead of a silent zero when a count could not be read', () => {
    expect(dependencyBadge({ waiting: null, satisfied: 1, unmeetable: 0, missing: 0 })).toEqual({
      kind: 'unknown',
      count: 0
    })
    expect(dependencyBadge({ waiting: 0, satisfied: 0, unmeetable: null, missing: 0 })).toEqual({
      kind: 'unknown',
      count: 0
    })
    // A known blocker still wins over an unread count.
    expect(dependencyBadge({ waiting: 2, satisfied: 0, unmeetable: null, missing: 0 })).toEqual({
      kind: 'waiting',
      count: 2
    })
  })

  it('explains the refusals in plain English and keeps the hub words otherwise', () => {
    const refused = (code: string, status: number, message = 'hub said so') =>
      taskDependencyRefusalMessage(new WorkflowRequestError({ code, status, message }))
    expect(refused('dependency_cycle', 400)).toMatch(/wait on each other/)
    expect(refused('card-not-ours', 409)).toMatch(/another console/)
    expect(refused('forbidden', 403)).toMatch(/do not have access/)
    expect(refused('not_found', 404)).toMatch(/no longer exists/)
    expect(refused('validation', 422, 'condition must be DONE or VERIFIED')).toBe(
      'condition must be DONE or VERIFIED'
    )
    expect(
      refused('validation', 400, 'dependency inputs may only change while card is open')
    ).toMatch(/only be added while the task is open/)
  })

  it('says unknown for a summary the console could not read at all, and nothing for an absent one', () => {
    // An older console has no dependency feature: silence, not an alarm on every card.
    expect(dependencyBadge(undefined)).toBeNull()
    // `null` is this console saying it could not read one, which must never look healthy.
    expect(dependencyBadge(null)).toEqual({ kind: 'unknown', count: 0 })
  })

  it('never calls an unread condition "when done"', () => {
    expect(dependencyConditionLabel('DONE')).toBe('when done')
    expect(dependencyConditionLabel('VERIFIED')).toBe('when verified')
    expect(dependencyConditionLabel(null)).toBe('condition unknown')
    expect(dependencyConditionLabel(undefined)).toBe('condition unknown')
  })

  it('offers no candidate while any existing edge is out of sight', () => {
    const cards = [card('btk_free0001', 'Free one')]
    const whole = { task_id: 'btk_self0001', depends_on: [], dependents: [] }
    expect(dependencyLinkageComplete(whole)).toBe(true)
    expect(dependencyCandidates(cards, 'btk_self0001', whole, '').map((c) => c.id)).toEqual([
      'btk_free0001'
    ])
    // Truncated at the console's 50-edge cap: edge 51 is linked but invisible, so nothing is safe.
    const truncated = { ...whole, truncated: true }
    expect(dependencyLinkageComplete(truncated)).toBe(false)
    expect(dependencyCandidates(cards, 'btk_self0001', truncated, '')).toEqual([])
    // A direction that could not be read hides links the same way.
    const unreadable = { ...whole, depends_on: null }
    expect(dependencyLinkageComplete(unreadable)).toBe(false)
    expect(dependencyCandidates(cards, 'btk_self0001', unreadable, '')).toEqual([])
  })

  it('refuses Add for the statuses the hub will not accept, and allows the rest', () => {
    // The hub takes dependency edits only while the card is open (collab/store.py:3157).
    expect(dependencyAddRefusal('open')).toBeNull()
    expect(dependencyAddRefusal(null)).toBeNull()
    expect(dependencyAddRefusal('ready')).toBeNull()
    expect(dependencyAddRefusal('done')).toMatch(/closed/)
    expect(dependencyAddRefusal('cancelled')).toMatch(/closed/)
    expect(dependencyAddRefusal('in_progress')).toMatch(/only be added while the task is open/)
    expect(dependencyAddRefusal('blocked')).toMatch(/blocked/)
  })

  it('keeps the hub’s cause-specific badge words instead of a generic can’t-proceed', () => {
    const hub = [{ kind: 'dependency_unmeetable', label: "Can't proceed: dependency cancelled" }]
    expect(dependencyBadgeLabel({ kind: 'unmeetable', count: 1 }, hub)).toBe(
      "Can't proceed: dependency cancelled"
    )
    expect(dependencyBadgeLabel({ kind: 'unmeetable', count: 1 }, [])).toBe("Can't proceed")
    expect(dependencyBadgeLabel({ kind: 'unmeetable', count: 1 }, null)).toBe("Can't proceed")
    expect(dependencyBadgeLabel({ kind: 'waiting', count: 3 }, hub)).toBe('Waiting on 3')
    expect(dependencyBadgeLabel({ kind: 'unknown', count: 0 }, hub)).toBe('Dependencies unknown')
  })
})
