import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JEV_RUBRIC_METHODS } from '../../../../shared/jev-rubrics'
import { rubricLibrary } from '../../../../shared/rubric-library'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { RpcContext } from '../core'
import { JEV_RUBRIC_RPC_METHODS } from './jev-rubrics'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('../../../structured-decisions/decision-runtime', () => ({
  getStructuredDecisionRuntime: lookup
}))

const saved = {
  name: 'Our reply',
  instructions: '- Accurate facts\n- Clear next step',
  kind: 'reply' as const
}
const input = { rubric: saved.name, task: 'Judge the draft', response: 'Draft reply' }

function harness(effective: 'on' | 'off' = 'on') {
  const library = rubricLibrary([saved])
  const getJevRubricLibrary = vi.fn(() => library)
  const saveJevRubric = vi.fn(() => library.at(-1))
  const runtime = { getJevRubricLibrary, saveJevRubric } as unknown as OrcaRuntimeService
  const status = vi.fn().mockResolvedValue({ effective })
  const evaluateRubric = vi.fn().mockResolvedValue({ status: 'verdict', action_authorized: false })
  lookup.mockReturnValue({ jev: { status }, evaluateRubric })
  const invoke = (name: string, params: unknown, extra: Partial<RpcContext> = {}) => {
    const target = JEV_RUBRIC_RPC_METHODS.find((method) => method.name === name)!
    return target.handler(target.params!.parse(params), { runtime, ...extra })
  }
  return { library, getJevRubricLibrary, saveJevRubric, status, evaluateRubric, invoke }
}

beforeEach(() => lookup.mockReset())

describe('JEV agent rubric RPC', () => {
  it('lists and saves this runtime library without needing JEV or a provider credential', () => {
    const h = harness('off')
    expect(h.invoke(JEV_RUBRIC_METHODS.list, {})).toEqual({ rubrics: h.library })
    expect(h.invoke(JEV_RUBRIC_METHODS.save, { rubric: saved })).toEqual({
      rubric: h.library.at(-1)
    })
    expect(h.saveJevRubric).toHaveBeenCalledExactlyOnceWith(saved, false)
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each([
    ['off', 'on', true],
    ['request', 'off', true],
    ['on', 'off', true],
    ['auto', 'on', false],
    ['request', 'on', false]
  ] as const)(
    'preserves requested %s control on an %s host',
    async (control, effective, disabled) => {
      const h = harness(effective)
      await h.invoke(
        JEV_RUBRIC_METHODS.evaluate,
        { input, control },
        {
          clientKind: 'runtime',
          connectionId: 'paired-runtime'
        }
      )
      expect(h.evaluateRubric).toHaveBeenCalledExactlyOnceWith(
        input,
        expect.objectContaining({ value: 'saved:Our reply' }),
        { disabled, control }
      )
      expect(h.getJevRubricLibrary).toHaveBeenCalledTimes(1)
    }
  )

  it('freezes the selected rubric before waiting for host status', async () => {
    const h = harness()
    let resolve!: (value: { effective: 'on' }) => void
    h.status.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const pending = h.invoke(JEV_RUBRIC_METHODS.evaluate, { input })
    h.library.at(-1)!.rubric.instructions = 'Edited while the request waits'
    resolve({ effective: 'on' })
    await pending
    const admitted = h.evaluateRubric.mock.calls[0]![1]
    expect(admitted.rubric.instructions).toBe(saved.instructions)
    expect(Object.isFrozen(admitted.rubric)).toBe(true)
  })

  it('rejects unknown selectors and oversized or untrusted extra fields before evaluation', async () => {
    const h = harness()
    await expect(
      h.invoke(JEV_RUBRIC_METHODS.evaluate, { input: { ...input, rubric: 'Missing' } })
    ).rejects.toThrow('not found')
    for (const params of [
      { input: { ...input, response: '語'.repeat(17000) } },
      { input, apiKey: 'caller-key' },
      { input: { ...input, actions: ['send'] } }
    ]) {
      expect(() => h.invoke(JEV_RUBRIC_METHODS.evaluate, params)).toThrow()
    }
    expect(h.evaluateRubric).not.toHaveBeenCalled()
    expect(h.status).not.toHaveBeenCalled()
  })
})
