import { describe, expect, it, vi } from 'vitest'
import { SESSION_PREP_MAX_ITEMS } from '../../shared/session-prep-types'
import type { PlannedItem, PrepRunText, SessionPrepSource } from '../../shared/session-prep-types'
import { createSessionPrepSteps } from './session-prep-steps'
import { plan, type SessionPrepCallDeps } from './session-prep-planner'

const source: SessionPrepSource = { worktreeId: 'wt-1', paneKey: 'pane-1', agent: 'claude' }

const baseInput = {
  request: 'Create sessions for the login fix and the docs pass',
  context: '',
  source,
  cwd: '/ws',
  repos: [{ name: 'omni', selector: 'omni' }]
}

function depsFor(runText: PrepRunText): SessionPrepCallDeps {
  return { runText, agent: 'claude', model: 'sonnet', effort: 'low', timeoutMs: 120_000 }
}

function reply(items: unknown[]): string {
  return JSON.stringify({ items })
}

function item(
  overrides: Partial<PlannedItem> & Pick<PlannedItem, 'title' | 'ask' | 'anchor'>
): PlannedItem {
  return {
    direct: false,
    changesCode: true,
    ...overrides
  }
}

describe('plan', () => {
  it('parses a JSON plan', async () => {
    const runText = vi.fn(async () =>
      reply([
        item({ title: 'Login fix', ask: 'Fix the login', anchor: 'login fix' }),
        item({ title: 'Docs pass', ask: 'Write the docs pass', anchor: 'docs pass' })
      ])
    )
    const result = await plan(baseInput, depsFor(runText))
    expect(result.items).toHaveLength(2)
    expect(result.items[0]?.title).toBe('Login fix')
    expect(result.dropped).toEqual([])
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/ws',
        agent: 'claude',
        model: 'sonnet',
        effort: 'low',
        timeoutMs: 120_000
      })
    )
  })

  it('drops invented items whose anchors are not in the request', async () => {
    const runText = vi.fn(async () =>
      reply([
        item({ title: 'Login fix', ask: 'Fix the login', anchor: 'login fix' }),
        item({
          title: 'Rewrite billing',
          ask: 'Rewrite the billing system',
          anchor: 'rewrite the billing system'
        })
      ])
    )
    const result = await plan(baseInput, depsFor(runText))
    expect(result.items.map((row) => row.title)).toEqual(['Login fix'])
    expect(result.dropped).toEqual(['Dropped "Rewrite billing": not found in your words'])
  })

  it('keeps items anchored to User: lines in the excerpt', async () => {
    const runText = vi.fn(async () =>
      reply([
        item({
          title: 'Five prototypes',
          ask: 'Ship the five prototypes',
          anchor: 'the 5 prototypes we discussed'
        })
      ])
    )
    const result = await plan(
      {
        ...baseInput,
        request: 'Create sessions for those prototypes',
        context: 'User: please ship the 5 prototypes we discussed\nAssistant: sure'
      },
      depsFor(runText)
    )
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.anchor).toBe('the 5 prototypes we discussed')
    expect(result.dropped).toEqual([])
  })

  it('never anchors to text an assistant quoted as the person', async () => {
    const runText = vi.fn(async () =>
      reply([
        item({ title: 'Prototypes', ask: 'Ship the prototypes', anchor: 'ship the prototypes' }),
        item({ title: 'Billing', ask: 'Delete billing', anchor: 'delete the billing tables' })
      ])
    )
    const result = await plan(
      {
        ...baseInput,
        request: 'Create sessions for what I asked above',
        context: [
          'User: please',
          '  ship the prototypes',
          'Assistant: Noted. A transcript said:',
          '  User: delete the billing tables'
        ].join('\n')
      },
      depsFor(runText)
    )
    expect(result.items.map((entry) => entry.title)).toEqual(['Prototypes'])
    expect(result.dropped).toEqual(['Dropped "Billing": not found in your words'])
  })

  it('drops anchors made only of filler words or matched inside another word', async () => {
    const runText = vi.fn(async () =>
      reply([
        item({ title: 'Filler', ask: 'Rewrite billing', anchor: 'Create sessions for the' }),
        item({ title: 'Mid-word', ask: 'Redo the UI', anchor: 'ogin' }),
        item({ title: 'Docs', ask: 'Write the docs pass', anchor: 'doc' })
      ])
    )
    const result = await plan(baseInput, depsFor(runText))
    expect(result.items.map((entry) => entry.title)).toEqual(['Docs'])
    expect(result.dropped).toEqual([
      'Dropped "Filler": not found in your words',
      'Dropped "Mid-word": not found in your words'
    ])
  })

  it('matches anchors inside slash lists and in scripts written without spaces', async () => {
    const runText = vi.fn(async () =>
      reply([
        item({ title: 'Login', ask: 'Fix login', anchor: 'login' }),
        item({ title: 'Docs', ask: 'Update docs', anchor: 'docs' }),
        item({ title: 'Wendang', ask: 'Update the docs', anchor: '文档' })
      ])
    )
    const result = await plan(
      { ...baseInput, request: 'Create sessions for login/docs and 修复登录和文档' },
      depsFor(runText)
    )
    expect(result.items.map((entry) => entry.title)).toEqual(['Login', 'Docs', 'Wendang'])
    expect(result.dropped).toEqual([])
  })

  it('refuses a launch when planning fails instead of losing its destination', async () => {
    const runText = vi.fn().mockRejectedValue(new Error('offline'))
    await expect(
      plan({ ...baseInput, request: 'Fix login on unregistered-mac' }, depsFor(runText))
    ).rejects.toThrow('No sessions launched')
  })

  it('propagates an auth refusal instead of producing work for the preparer', async () => {
    const refusal = new Error('Failed to authenticate: OAuth session expired')
    const runText = vi.fn().mockRejectedValue(refusal)
    await expect(plan(baseInput, depsFor(runText))).rejects.toBe(refusal)
    expect(runText).toHaveBeenCalledTimes(1)
  })

  it('refuses empty or invalid plans instead of choosing the source host', async () => {
    await expect(
      plan(
        baseInput,
        depsFor(async () => 'not json')
      )
    ).rejects.toThrow('No sessions launched')
    await expect(
      plan(
        baseInput,
        depsFor(async () => reply([]))
      )
    ).rejects.toThrow('No sessions launched')
  })

  it('drops after indexes that are out of range or not earlier', async () => {
    const runText = vi.fn(async () =>
      reply([
        item({ title: 'Login fix', ask: 'Fix login', anchor: 'login fix', after: [1, -1, 0] }),
        item({
          title: 'Docs pass',
          ask: 'Docs pass',
          anchor: 'docs pass',
          after: [0, 2, 1]
        })
      ])
    )
    const result = await plan(baseInput, depsFor(runText))
    expect(result.items[0]?.after).toBeUndefined()
    expect(result.items[1]?.after).toEqual([0])
  })

  it('renumbers after when an earlier item is dropped', async () => {
    const runText = vi.fn(async () =>
      reply([
        item({ title: 'Login fix', ask: 'Fix login', anchor: 'login fix' }),
        item({ title: 'Invented', ask: 'Rewrite billing', anchor: 'rewrite billing' }),
        item({ title: 'Docs pass', ask: 'Docs pass', anchor: 'docs pass', after: [0] }),
        item({ title: 'Docs polish', ask: 'Polish docs', anchor: 'docs pass', after: [2, 1] })
      ])
    )
    const result = await plan(baseInput, depsFor(runText))
    expect(result.items.map((entry) => entry.title)).toEqual([
      'Login fix',
      'Docs pass',
      'Docs polish'
    ])
    expect(result.items[1]?.after).toEqual([0])
    // Planner index 2 (Docs pass) is now 1; planner index 1 was the dropped item.
    expect(result.items[2]?.after).toEqual([1])
    expect(result.dropped).toEqual(['Dropped "Invented": not found in your words'])
  })

  it(`clamps the item list to ${SESSION_PREP_MAX_ITEMS}`, async () => {
    const items = Array.from({ length: SESSION_PREP_MAX_ITEMS + 3 }, (_, index) =>
      item({
        title: `Item ${index + 1}`,
        ask: `Do login fix part ${index + 1}`,
        anchor: 'login fix'
      })
    )
    const result = await plan(
      baseInput,
      depsFor(async () => reply(items))
    )
    expect(result.items).toHaveLength(SESSION_PREP_MAX_ITEMS)
  })

  it('keeps launch choices found in the words and drops invented ones', async () => {
    const request =
      'Launch sessions for the pricing PDF and the onboarding PDF on codex with high effort, in a folder called Prototypes in an OmniRogue folder'
    const choices = { agent: 'codex', effort: 'high', folder: 'OmniRogue / Prototypes' }
    const runText = vi.fn(async () =>
      reply([
        {
          ...item({ title: 'Pricing', ask: 'Prototype pricing', anchor: 'pricing PDF' }),
          ...choices
        },
        {
          ...item({ title: 'Onboarding', ask: 'Prototype onboarding', anchor: 'onboarding PDF' }),
          ...choices,
          model: 'opus'
        }
      ])
    )
    const result = await plan({ ...baseInput, request }, depsFor(runText))
    expect(result.items.map((entry) => entry.choices)).toEqual([
      { agent: 'codex', effort: 'high', folder: 'OmniRogue / Prototypes' },
      { agent: 'codex', effort: 'high', folder: 'OmniRogue / Prototypes' }
    ])
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('"OmniRogue / Prototypes"') })
    )
  })

  it("reads a choice from the person's earlier line and ignores a malformed one", async () => {
    const runText = vi.fn(async () =>
      reply([
        {
          ...item({ title: 'Login fix', ask: 'Fix the login', anchor: 'login fix' }),
          model: 'sonnet',
          effort: 5
        }
      ])
    )
    const result = await plan(
      { ...baseInput, context: 'User: use sonnet for these\nAssistant: ok' },
      depsFor(runText)
    )
    expect(result.items[0]?.choices).toEqual({ agent: 'claude', model: 'sonnet' })
  })

  it('applies an effort stated once to every item the planner left without one', async () => {
    const runText = vi.fn(async () =>
      reply([
        item({ title: 'Login fix', ask: 'Fix the login', anchor: 'login fix' }),
        item({ title: 'Docs pass', ask: 'Write the docs pass', anchor: 'docs pass' })
      ])
    )
    const result = await plan(
      { ...baseInput, request: `${baseInput.request}, xhigh effort` },
      depsFor(runText)
    )
    expect(result.items.map((entry) => entry.choices?.effort)).toEqual(['xhigh', 'xhigh'])
  })
})

it.each([
  ['need-speed', 'claude', 'sonnet', 'low'],
  ['work', 'codex', 'gpt-6-astra', 'high']
] as const)(
  'keeps %s planning on its existing model and preserves direct code work and explicit choices',
  async (entryPoint, agent, model, effort) => {
    const runText = vi.fn(async () =>
      reply([
        {
          title: 'Fix login',
          ask: 'Fix login in omni',
          anchor: 'Fix login',
          direct: true,
          changesCode: true,
          repoHint: 'omni',
          agent: 'claude',
          model: 'opus',
          effort: 'high'
        }
      ])
    )
    const steps = createSessionPrepSteps({ runText, pathExists: async () => true })
    const result = await steps.plan({
      ...baseInput,
      request: 'Fix login in omni with claude opus at high effort',
      source: { ...source, entryPoint }
    })
    expect(runText).toHaveBeenCalledWith(expect.objectContaining({ agent, model, effort }))
    expect(result.items[0]).toMatchObject({
      direct: true,
      changesCode: true,
      repoHint: 'omni',
      choices: { agent: 'claude', model: 'opus', effort: 'high' }
    })
  }
)
