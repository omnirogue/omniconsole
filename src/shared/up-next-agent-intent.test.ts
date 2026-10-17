import { describe, expect, it } from 'vitest'
import { SESSION_ACTION_PRESET_IDS } from './session-action-presets'
import {
  UP_NEXT_HANDOFF_TEMPLATES,
  UP_NEXT_REVIEW_TEMPLATES,
  upNextAgentIntent,
  upNextIntentTemplates,
  upNextStageOutput,
  upNextTemplateChoices
} from './up-next-agent-intent'
import { WorkPlanLayoutStageSchema } from './work-plan-layouts'
import type { UpNextAgentTemplate } from './up-next-types'

const EVERY_TEMPLATE: UpNextAgentTemplate[] = [...SESSION_ACTION_PRESET_IDS, 'custom']

describe('review vs handoff', () => {
  it('offers exactly Review, Adversarial Review and Verify under + Agent Review', () => {
    expect(upNextIntentTemplates('review')).toEqual(['review', 'critique', 'verify'])
  })

  it('offers exactly Implement, Improve, Research, Plan and Custom under + Agent Handoff', () => {
    expect(upNextIntentTemplates('handoff')).toEqual([
      'implement',
      'improve',
      'research',
      'plan',
      'custom'
    ])
  })

  it('keeps the two menus mutually exclusive, and offers Judge in neither', () => {
    const review = new Set<UpNextAgentTemplate>(UP_NEXT_REVIEW_TEMPLATES)
    expect(UP_NEXT_HANDOFF_TEMPLATES.filter((template) => review.has(template))).toEqual([])
    expect([...UP_NEXT_REVIEW_TEMPLATES, ...UP_NEXT_HANDOFF_TEMPLATES]).not.toContain('judge')
  })

  it('classifies every menu item by what it hands on, not by which list it sits in', () => {
    for (const template of UP_NEXT_REVIEW_TEMPLATES) {
      expect(upNextAgentIntent(template)).toBe('review')
      expect(upNextStageOutput(template)).not.toBe('result')
    }
    for (const template of UP_NEXT_HANDOFF_TEMPLATES) {
      expect(upNextAgentIntent(template)).toBe('handoff')
      expect(upNextStageOutput(template)).toBe('result')
    }
  })

  it('keeps the outputs the engine already reported for every template', () => {
    expect(Object.fromEntries(EVERY_TEMPLATE.map((t) => [t, upNextStageOutput(t)]))).toEqual({
      research: 'result',
      analyze: 'findings',
      plan: 'result',
      implement: 'result',
      improve: 'result',
      synthesize: 'result',
      verify: 'verdict',
      review: 'findings',
      critique: 'findings',
      compare: 'findings',
      judge: 'winner',
      summarize: 'result',
      test: 'verdict',
      repair: 'result',
      custom: 'result'
    })
  })
})

describe('older saved stages', () => {
  it('still classify when the menus no longer offer their template', () => {
    expect(upNextAgentIntent('judge')).toBe('review')
    expect(upNextAgentIntent('compare')).toBe('review')
    expect(upNextAgentIntent('test')).toBe('review')
    expect(upNextAgentIntent('synthesize')).toBe('handoff')
    expect(upNextAgentIntent('repair')).toBe('handoff')
  })

  it('keep their own template on the stage card instead of being silently changed', () => {
    expect(upNextTemplateChoices('judge')).toEqual(['review', 'critique', 'verify', 'judge'])
    expect(upNextTemplateChoices('synthesize')).toEqual([
      'implement',
      'improve',
      'research',
      'plan',
      'custom',
      'synthesize'
    ])
    // A card never offers a switch across intents.
    expect(upNextTemplateChoices('verify')).toEqual(['review', 'critique', 'verify'])
    expect(upNextTemplateChoices('improve')).not.toContain('verify')
  })

  it('still parse as saved workflow stages, every template included', () => {
    for (const template of EVERY_TEMPLATE) {
      expect(WorkPlanLayoutStageSchema.safeParse({ kind: 'agent', template }).success).toBe(true)
    }
  })
})
