import { describe, expect, it } from 'vitest'
import type { PlannedItem } from '../../shared/session-prep-types'
import {
  mergePlannedChoices,
  modelAgentFamily,
  sanitizePlannedChoices,
  statedEfforts,
  withStatedBatchEffort
} from './session-prep-choices'

const SAL_REQUEST =
  'launch sessions for these two PDFs on my Desktop, on codex with high effort, in a folder called Prototypes in an OmniRogue folder'

function item(over: Partial<PlannedItem> = {}): PlannedItem {
  return { title: 'A', ask: 'a', anchor: 'a', direct: false, changesCode: false, ...over }
}

describe('statedEfforts', () => {
  it('reads the levels people say', () => {
    expect([...statedEfforts('do it with high effort')]).toEqual(['high'])
    expect([...statedEfforts('xhigh please')]).toEqual(['xhigh'])
    expect([...statedEfforts('use max effort on this')]).toEqual(['max'])
    expect([...statedEfforts('Low-effort docs pass')]).toEqual(['low'])
    expect([...statedEfforts('extra-high reasoning')]).toEqual(['xhigh'])
    expect([...statedEfforts('effort: medium')]).toEqual(['medium'])
    expect([...statedEfforts('maximum effort')]).toEqual(['max'])
  })

  it('ignores level words that are not about effort', () => {
    expect(statedEfforts('a high priority fix and a low-risk change').size).toBe(0)
    expect(statedEfforts('max out the budget').size).toBe(0)
  })
})

describe('sanitizePlannedChoices', () => {
  it("keeps Sal's folder, agent and effort from his words", () => {
    expect(
      sanitizePlannedChoices(
        { agent: 'codex', effort: 'high', folder: 'OmniRogue/Prototypes' },
        SAL_REQUEST
      )
    ).toEqual({ agent: 'codex', effort: 'high', folder: 'OmniRogue / Prototypes' })
  })

  it('drops every choice the person did not state', () => {
    expect(
      sanitizePlannedChoices(
        { agent: 'claude', model: 'opus', effort: 'xhigh', folder: 'Clients / Acme' },
        'create sessions for the login fix and the docs'
      )
    ).toBeUndefined()
  })

  it('drops an effort level the planner changed', () => {
    expect(sanitizePlannedChoices({ effort: 'max' }, 'do it on high effort')).toBeUndefined()
  })

  it('takes the agent from a named model', () => {
    expect(sanitizePlannedChoices({ model: 'opus' }, 'use opus for both')).toEqual({
      agent: 'claude',
      model: 'opus'
    })
    expect(sanitizePlannedChoices({ model: 'gpt-5.6-sol' }, 'run it on sol')).toEqual({
      agent: 'codex',
      model: 'gpt-5.6-sol'
    })
  })

  it('drops a model that belongs to a different named agent', () => {
    expect(sanitizePlannedChoices({ agent: 'codex', model: 'opus' }, 'codex with opus')).toEqual({
      agent: 'codex'
    })
  })

  it('rejects unknown agents and folder segments missing from the words', () => {
    expect(sanitizePlannedChoices({ agent: 'robot' }, 'use robot')).toBeUndefined()
    expect(
      sanitizePlannedChoices({ folder: 'OmniRogue / Secret' }, 'put them in OmniRogue')
    ).toBeUndefined()
  })

  it('lets a folder path start at Saved Sessions without the person saying it', () => {
    expect(
      sanitizePlannedChoices({ folder: 'Saved Sessions / OmniRogue' }, 'file them under OmniRogue')
    ).toEqual({ folder: 'Saved Sessions / OmniRogue' })
  })
})

describe('withStatedBatchEffort', () => {
  it('applies one stated effort to every item when the planner placed none', () => {
    const items = withStatedBatchEffort([item(), item({ title: 'B' })], 'two sessions, xhigh')
    expect(items.map((entry) => entry.choices?.effort)).toEqual(['xhigh', 'xhigh'])
  })

  it('leaves per-item efforts and ambiguous requests alone', () => {
    const placed = [item({ choices: { effort: 'low' } }), item()]
    expect(withStatedBatchEffort(placed, 'A on low effort, B on high effort')).toBe(placed)
    const plain = [item()]
    expect(withStatedBatchEffort(plain, 'A on low effort, B on high effort')).toBe(plain)
  })
})

describe('mergePlannedChoices', () => {
  it('keeps the first part choices and fills gaps from later parts', () => {
    expect(
      mergePlannedChoices([
        item({ choices: { effort: 'high' } }),
        item({ choices: { effort: 'low', folder: 'OmniRogue' } })
      ])
    ).toEqual({ effort: 'high', folder: 'OmniRogue' })
    expect(mergePlannedChoices([item(), item()])).toBeUndefined()
  })
})

describe('modelAgentFamily', () => {
  it('knows Claude and Codex models only', () => {
    expect(modelAgentFamily('sonnet')).toBe('claude')
    expect(modelAgentFamily('gpt-6-astra')).toBe('codex')
    expect(modelAgentFamily('kimi-k2')).toBeNull()
  })
})

describe('sanitizePlannedChoices agentTemplate', () => {
  const templates = [
    { id: 'reviewer', name: 'Reviewer' },
    { id: 'docs-writer', name: 'Docs Writer' }
  ]

  it('keeps a template whose name the person said, by id or name', () => {
    const words = 'create a session to check PR 12 as a reviewer'
    expect(sanitizePlannedChoices({ agentTemplate: 'reviewer' }, words, templates)).toEqual({
      agentTemplate: 'reviewer'
    })
    expect(
      sanitizePlannedChoices(
        { agentTemplate: 'Docs Writer' },
        'use the docs-writer template',
        templates
      )
    ).toEqual({ agentTemplate: 'docs-writer' })
    expect(
      sanitizePlannedChoices({ agentTemplate: 'reviewer' }, 'with Reviewer instructions', templates)
    ).toEqual({ agentTemplate: 'reviewer' })
  })

  it.each([
    'launch two sessions as reviewers',
    'start a reviewer agent on PR 12',
    'spin up reviewer agents for both PRs',
    'check it in reviewer mode',
    'use the reviewer persona',
    'fix it using the reviewer',
    'use the reviewer for PR 12'
  ])('keeps a template named in a common form: %s', (words) => {
    expect(sanitizePlannedChoices({ agentTemplate: 'reviewer' }, words, templates)).toEqual({
      agentTemplate: 'reviewer'
    })
  })

  it('ignores a template name used as an ordinary word', () => {
    expect(
      sanitizePlannedChoices(
        { agentTemplate: 'reviewer' },
        'fix the login and have a reviewer look at it',
        templates
      )
    ).toBeUndefined()
    expect(
      sanitizePlannedChoices({ agentTemplate: 'Docs Writer' }, 'ask the docs writer', templates)
    ).toBeUndefined()
  })

  it('drops a template the person never named or that does not exist here', () => {
    expect(
      sanitizePlannedChoices({ agentTemplate: 'reviewer' }, 'fix the login', templates)
    ).toBeUndefined()
    expect(
      sanitizePlannedChoices({ agentTemplate: 'researcher' }, 'as a researcher', templates)
    ).toBeUndefined()
    expect(sanitizePlannedChoices({ agentTemplate: 'reviewer' }, 'as a reviewer')).toBeUndefined()
  })
})
