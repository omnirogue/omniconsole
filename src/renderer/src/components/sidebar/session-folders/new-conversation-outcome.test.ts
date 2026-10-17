import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_NEW_CONVERSATION_OUTCOME,
  launchTaskChoices,
  newConversationLaunchExtras,
  newConversationPlansTeam
} from './new-conversation-outcome'
import type { WorkCard } from '../../../../../shared/console-work-home-contract'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const now = new Date('2026-09-15T18:00:00.000Z')

describe('new conversation outcome fields', () => {
  it('adds nothing to the one-click launch until an outcome or task is chosen', () => {
    expect(newConversationLaunchExtras(EMPTY_NEW_CONVERSATION_OUTCOME, now)).toEqual({})
    expect(
      newConversationLaunchExtras({ ...EMPTY_NEW_CONVERSATION_OUTCOME, outcome: '   ' }, now)
    ).toEqual({})
  })

  it('keeps a typed outcome a plain goal unless the user opts into planning the team', () => {
    const draft = { ...EMPTY_NEW_CONVERSATION_OUTCOME, outcome: ' Export ships with tests ' }
    expect(newConversationPlansTeam(draft)).toBe(false)
    expect(newConversationLaunchExtras(draft, now)).toEqual({
      outcome: { text: 'Export ships with tests' }
    })
    const optedIn = { ...draft, planMode: true }
    expect(newConversationLaunchExtras(optedIn, now)).toEqual({
      outcome: { text: 'Export ships with tests', teamPlanConsentedAt: now.toISOString() }
    })
    expect(newConversationPlansTeam({ ...EMPTY_NEW_CONVERSATION_OUTCOME, planMode: true })).toBe(
      false
    )
  })

  it('passes only a real hub card as the parent task', () => {
    expect(
      newConversationLaunchExtras({ ...EMPTY_NEW_CONVERSATION_OUTCOME, taskId: 'btk_card1' }, now)
    ).toEqual({ hubTaskId: 'btk_card1' })
    expect(
      newConversationLaunchExtras({ ...EMPTY_NEW_CONVERSATION_OUTCOME, taskId: 'not-a-card' }, now)
    ).toEqual({})
  })

  it('offers open top-level cards only', () => {
    const card = (overrides: Partial<WorkCard>): WorkCard =>
      ({ id: 'btk_open1', title: 'Open', status: 'open', ...overrides }) as WorkCard
    const choices = launchTaskChoices([
      card({}),
      card({ id: 'btk_done1', status: 'verified_complete' }),
      card({ id: 'btk_kdone', kanban_status: 'done' }),
      card({ id: 'btk_child', parent_task_id: 'btk_open1' }),
      card({ id: 'btk_hidden', kanban_eligible: false }),
      card({ id: 'task-legacy' }),
      ...Array.from({ length: 50 }, (_, index) =>
        card({ id: `btk_many${index}`, title: `T${index}` })
      )
    ])
    expect(choices[0]).toEqual({ id: 'btk_open1', title: 'Open' })
    expect(choices.map((choice) => choice.id)).not.toContain('btk_done1')
    expect(choices.map((choice) => choice.id)).not.toContain('btk_child')
    expect(choices.map((choice) => choice.id)).not.toContain('task-legacy')
    expect(choices).toHaveLength(40)
  })

  it('preserves the teamPlanConsentedAt wire marker byte-for-byte', () => {
    expect(
      newConversationLaunchExtras(
        { outcome: 'Ship', taskId: '', planMode: true },
        new Date('2026-09-17T00:00:00Z')
      )
    ).toEqual({ outcome: { text: 'Ship', teamPlanConsentedAt: '2026-09-17T00:00:00.000Z' } })
  })

  it('removes the old identifier from the renamed files', () => {
    for (const file of ['new-conversation-outcome.ts', 'NewConversationOutcomeFields.tsx']) {
      expect(
        readFileSync(resolve('src/renderer/src/components/sidebar/session-folders', file), 'utf8')
      ).not.toMatch(/\bplanTeam\b/)
    }
  })
})
