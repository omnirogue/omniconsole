import { describe, expect, it, vi } from 'vitest'
import type { PreparedFields } from '../../shared/session-prep-types'
import { createSessionPrepSteps } from './session-prep-steps'

const fields: PreparedFields = {
  title: 'Login fix',
  outcome: 'Login succeeds without a timeout.',
  doneWhen: ['Login test passes', 'Valid credentials sign in'],
  decided: [],
  references: [],
  constraints: [],
  assumptions: [],
  blockingQuestion: null,
  changesCode: true
}
const input = {
  item: {
    title: 'Login fix',
    ask: 'Fix the login timeout',
    anchor: 'login timeout',
    direct: false,
    changesCode: true
  },
  request: 'Fix the login timeout',
  context: '',
  cwd: '/workspace',
  connectionId: 'ssh-host'
}

describe('session prep writer model', () => {
  it.each([
    [undefined, 'codex', 'gpt-6-luna'],
    ['claude', 'claude', 'sonnet'],
    ['codex', 'codex', 'gpt-6-luna']
  ] as const)(
    'uses the measured writer while honoring override %s',
    async (modelAgent, agent, model) => {
      const runText = vi.fn(async () => JSON.stringify(fields))
      const steps = createSessionPrepSteps({ runText, modelAgent, pathExists: async () => true })
      await steps.prepare({ ...input, index: 0, siblings: [] })
      await steps.revise({ ...input, fields, failures: [] })
      expect(runText).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          agent,
          model,
          effort: 'medium',
          connectionId: 'ssh-host',
          timeoutMs: 360_000
        })
      )
      expect(runText).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          agent,
          model,
          effort: 'low',
          connectionId: 'ssh-host',
          timeoutMs: 180_000
        })
      )
    }
  )

  it('keeps the fallback judge on Claude Sonnet and existing JEV thresholds', async () => {
    const runText = vi.fn(async () => JSON.stringify({ consistent: true, ready: true }))
    const pathExists = vi.fn(async () => true)
    const fallback = createSessionPrepSteps({ runText, pathExists })
    expect((await fallback.gate({ ...input, fields })).pass).toBe(true)
    expect(runText).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        model: 'sonnet',
        effort: 'low',
        connectionId: 'ssh-host'
      })
    )
    runText.mockClear()
    const jev = createSessionPrepSteps({
      runText,
      pathExists,
      jevAsk: async () => ({ consistent: 0.9, ready: 0.49 })
    })
    expect(await jev.gate({ ...input, fields })).toMatchObject({ pass: false, judge: 'jev' })
    expect(runText).not.toHaveBeenCalled()
  })
})
