// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyNextStepDraft, type NextStepDraft } from '../../../../shared/next-step-draft'
import { nextStepTemplateDraft } from '../../../../shared/next-step-templates'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
import { SessionTeamPlanPreview } from './SessionTeamPlanPreview'
afterEach(cleanup)

let keys = 0
const agents = ['claude', 'codex', 'grok'] as const
const template = (id: Parameters<typeof nextStepTemplateDraft>[0]): NextStepDraft =>
  nextStepTemplateDraft(id, { agents, mintKey: () => `k${(keys += 1)}` })!

describe('SessionTeamPlanPreview', () => {
  it('draws the Best of N template as candidates together, then the judge, then the pick', () => {
    const { container } = render(
      <SessionTeamPlanPreview draft={template('best-of-n')} source={{ agent: 'kimi' }} />
    )
    const phases = [...container.querySelectorAll('[data-session-team-phase]')]
    expect(phases.map((phase) => phase.getAttribute('data-session-team-phase'))).toEqual([
      'work',
      'review',
      'work'
    ])
    expect(phases[0]!.querySelectorAll('[data-session-team-seat]')).toHaveLength(2)
    expect(phases[0]!.textContent).toContain('2 together')
    expect(
      [...container.querySelectorAll('[data-session-team-seat]')].map((seat) =>
        seat.getAttribute('data-session-team-seat')
      )
    ).toEqual(['planned', 'planned', 'planned', 'planned'])
    expect(container.querySelector('[data-session-team-policy]')).toBeNull()
  })

  it('names a Gemini reviewer as blocked before anything is sent', () => {
    const draft: NextStepDraft = {
      ...emptyNextStepDraft(),
      recipients: [
        {
          kind: 'agent',
          key: 'r1',
          agent: 'gemini',
          presetId: 'review',
          instructions: '',
          rounds: 1
        }
      ]
    }
    const { container } = render(
      <SessionTeamPlanPreview draft={draft} source={{ agent: 'claude', model: 'opus' }} />
    )
    const line = container.querySelector('[data-session-team-policy-level="block"]')
    expect(line?.textContent).toContain('Gemini never issues a review verdict')
  })

  it('warns, but does not block, a reviewer from the producer’s own family', () => {
    const draft: NextStepDraft = {
      ...emptyNextStepDraft(),
      recipients: [
        {
          kind: 'agent',
          key: 'r1',
          agent: 'claude',
          model: 'sonnet',
          presetId: 'review',
          instructions: '',
          rounds: 1
        }
      ]
    }
    const { container } = render(
      <SessionTeamPlanPreview draft={draft} source={{ agent: 'claude', model: 'opus' }} />
    )
    expect(container.querySelector('[data-session-team-policy-level="block"]')).toBeNull()
    expect(
      container.querySelector('[data-session-team-policy-level="warn"]')?.textContent
    ).toContain('own family')
  })

  it('renders nothing for a draft with no agent seats', () => {
    const { container } = render(
      <SessionTeamPlanPreview draft={emptyNextStepDraft()} source={null} />
    )
    expect(container.querySelector('[data-session-team-preview]')).toBeNull()
  })
})
