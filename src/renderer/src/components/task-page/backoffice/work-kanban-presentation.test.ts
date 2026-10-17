import { describe, expect, it } from 'vitest'
import type { WorkCard } from '../../../../../shared/console-work-home-contract'
import { workKanbanBadges } from './work-kanban-presentation'

const cancelled = { kind: 'dependency_unmeetable', label: "Can't proceed: dependency cancelled" }
const card = (overrides: Partial<WorkCard>) =>
  ({
    id: 'btk_card0001',
    title: 'Ship it',
    status: 'open',
    kanban_badges: [cancelled],
    ...overrides
  }) as WorkCard

const kinds = (value: WorkCard) => workKanbanBadges(value, false).map((badge) => badge.kind)

describe('work kanban dependency badges', () => {
  it('drops the hub badge only when the dependency badge restates it', () => {
    // WorkCardDependencyBadge renders the same cause-specific label, so two would be a duplicate.
    expect(
      kinds(card({ dependency_summary: { waiting: 0, satisfied: 0, unmeetable: 1, missing: 0 } }))
    ).not.toContain('dependency_unmeetable')
  })

  it('keeps the hub’s cause when the summary itself cannot say the card is blocked', () => {
    // Unknown counts: the dependency badge can only say "unknown", so the hub's reason must stay.
    expect(
      kinds(
        card({
          dependency_summary: { waiting: null, satisfied: null, unmeetable: null, missing: null }
        })
      )
    ).toContain('dependency_unmeetable')
    expect(kinds(card({ dependency_summary: null }))).toContain('dependency_unmeetable')
    expect(kinds(card({}))).toContain('dependency_unmeetable')
    // A card that is merely waiting keeps it too.
    expect(
      kinds(card({ dependency_summary: { waiting: 2, satisfied: 0, unmeetable: 0, missing: 0 } }))
    ).toContain('dependency_unmeetable')
  })
})
