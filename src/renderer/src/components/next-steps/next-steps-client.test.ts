import { afterEach, expect, it, vi } from 'vitest'
import { NEXT_STEPS_RPC } from '../../../../shared/next-step-suggestions-rpc'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))

import { setNextStepAdPauses, setNextStepKeepGoing } from './next-steps-client'

const conversation = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }

afterEach(() => vi.clearAllMocks())

it('sends keep-going requests for one conversation in order, so a stop is never undone', async () => {
  const sent: boolean[] = []
  let releaseEnable: () => void = () => {}
  mocks.rpc.mockImplementation((_target: unknown, method: string, params: { enabled: boolean }) => {
    expect(method).toBe(NEXT_STEPS_RPC.keepGoing)
    sent.push(params.enabled)
    return params.enabled
      ? new Promise((resolve) => {
          releaseEnable = () => resolve({ state: { enabled: true } })
        })
      : Promise.resolve({ state: { enabled: false } })
  })
  const enable = setNextStepKeepGoing(conversation, true, 5)
  const stop = setNextStepKeepGoing(conversation, false, undefined, 'person-acted')
  await Promise.resolve()
  // The stop waits for the enable ahead of it to be answered.
  expect(sent).toEqual([true])
  releaseEnable()
  await expect(enable).resolves.toEqual({ enabled: true })
  await expect(stop).resolves.toEqual({ enabled: false })
  expect(sent).toEqual([true, false])
})

it('still sends a stop after an earlier request failed', async () => {
  mocks.rpc
    .mockRejectedValueOnce(new Error('host down'))
    .mockResolvedValueOnce({ state: { enabled: false } })
  await expect(setNextStepKeepGoing(conversation, true)).rejects.toThrow('host down')
  await expect(setNextStepKeepGoing(conversation, false)).resolves.toEqual({ enabled: false })
})

it('names the mode and prompt only for a push run, so an older host reads plain Keep going', async () => {
  mocks.rpc.mockResolvedValue({ state: { enabled: true } })
  await setNextStepKeepGoing(conversation, true, 4, undefined, { mode: 'next-step' })
  await setNextStepKeepGoing(conversation, true, 4, undefined, {
    mode: 'push-for-better',
    pushPrompt: 'Sharper.'
  })
  expect(mocks.rpc.mock.calls.map((call) => call[2])).toEqual([
    { conversation, enabled: true, maxRounds: 4 },
    { conversation, enabled: true, maxRounds: 4, mode: 'push-for-better', pushPrompt: 'Sharper.' }
  ])
})

it('sets one conversation’s ad-pause choice, and null to follow the global setting', async () => {
  mocks.rpc.mockResolvedValue({ state: { enabled: false } })
  await setNextStepAdPauses(conversation, 'ask-first')
  await setNextStepAdPauses(conversation, null)
  expect(mocks.rpc.mock.calls.map((call) => [call[1], call[2]])).toEqual([
    [NEXT_STEPS_RPC.adPauses, { conversation, adPauses: 'ask-first' }],
    [NEXT_STEPS_RPC.adPauses, { conversation, adPauses: null }]
  ])
})
