// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  NEXT_STEP_KEEP_GOING_DEFAULT_PUSH_PROMPT,
  type NextStepKeepGoingState,
  type NextStepKeepGoingStopReason
} from '../../../../shared/next-step-keep-going'
import { NEXT_STEPS_RPC } from '../../../../shared/next-step-suggestions-rpc'
import { useAppStore } from '@/store'
import { usePendingNextSteps } from './next-steps-pending-store'
import {
  keepGoingStopWords,
  NextStepsKeepGoingControl,
  NextStepsKeepGoingStatus
} from './NextStepsKeepGoing'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), keepGoing: [] as NextStepKeepGoingState[] }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  RuntimeRpcCallError: class extends Error {
    code = 'error'
  }
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

const SOURCE = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const running = (over: Partial<NextStepKeepGoingState> = {}): NextStepKeepGoingState => ({
  conversation: SOURCE,
  enabled: true,
  maxRounds: 10,
  roundsUsed: 2,
  startedAt: 1,
  ...over
})

function useSettings(nextStepSuggestions: Record<string, unknown>) {
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings, nextStepSuggestions } as never
  })
}

beforeEach(() => {
  mocks.keepGoing = []
  usePendingNextSteps.setState({
    counts: new Map(),
    keepGoing: new Map(),
    keepGoingStopsSeen: new Map(),
    keepGoingRevision: null,
    revision: null,
    unknown: false
  })
  useSettings({ enabled: true })
  mocks.rpc.mockImplementation(
    (_target: unknown, method: string, params: Record<string, unknown>) => {
      if (method === NEXT_STEPS_RPC.list) {
        return Promise.resolve({ sets: [], skips: [], revision: 1, keepGoing: mocks.keepGoing })
      }
      if (method === NEXT_STEPS_RPC.keepGoing) {
        const state = running({
          roundsUsed: 0,
          maxRounds: params.maxRounds as number,
          ...(params.mode ? { mode: params.mode as 'push-for-better' } : { mode: 'next-step' }),
          ...(params.pushPrompt ? { pushPrompt: params.pushPrompt as string } : {})
        })
        mocks.keepGoing = [state]
        return Promise.resolve({ state })
      }
      return Promise.reject(new Error(`unexpected ${method}`))
    }
  )
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const keepGoingCalls = () =>
  mocks.rpc.mock.calls.filter((call) => call[1] === NEXT_STEPS_RPC.keepGoing).map((c) => c[2])

it('offers Next steps by default, with no push prompt, and turns on as before', async () => {
  render(<NextStepsKeepGoingControl conversation={SOURCE} />)
  expect(screen.getByRole('combobox', { name: 'What Keep going sends' }).textContent).toContain(
    'Next steps'
  )
  expect(screen.queryByText('Prompt…')).toBeNull()
  fireEvent.click(await screen.findByRole('switch', { name: 'Keep going' }))
  await waitFor(() =>
    expect(keepGoingCalls()).toEqual([{ conversation: SOURCE, enabled: true, maxRounds: 10 }])
  )
})

it('in Push for better, shows the prompt with the default filled in and sends the edited one', async () => {
  useSettings({ enabled: true, keepGoingDefaultMode: 'push-for-better' })
  render(<NextStepsKeepGoingControl conversation={SOURCE} />)
  fireEvent.click(screen.getByText('Prompt…'))
  const field = (await screen.findByLabelText('Push prompt')) as HTMLTextAreaElement
  expect(field.value).toBe(NEXT_STEP_KEEP_GOING_DEFAULT_PUSH_PROMPT)
  fireEvent.change(field, { target: { value: 'Make the hook sharper.' } })
  fireEvent.click(screen.getByRole('switch', { name: 'Keep going' }))
  await waitFor(() =>
    expect(keepGoingCalls()).toEqual([
      {
        conversation: SOURCE,
        enabled: true,
        maxRounds: 10,
        mode: 'push-for-better',
        pushPrompt: 'Make the hook sharper.'
      }
    ])
  )
})

it('will not turn Push for better on with an empty prompt', async () => {
  useSettings({ enabled: true, keepGoingDefaultMode: 'push-for-better' })
  render(<NextStepsKeepGoingControl conversation={SOURCE} />)
  fireEvent.click(screen.getByText('Prompt…'))
  fireEvent.change(await screen.findByLabelText('Push prompt'), { target: { value: '   ' } })
  expect((screen.getByRole('switch', { name: 'Keep going' }) as HTMLButtonElement).disabled).toBe(
    true
  )
})

it.each([
  [running({ mode: 'push-for-better' }), 'Keep going · Push for better · round 2 of 10'],
  [running({ mode: 'next-step' }), 'Keep going · Next steps · round 2 of 10'],
  [running(), 'Keep going · round 2 of 10']
])('names the mode while it runs', async (state, line) => {
  mocks.keepGoing = [state]
  render(<NextStepsKeepGoingStatus conversation={SOURCE} />)
  expect(await screen.findByText(line)).toBeTruthy()
})

it.each([
  [
    running({ enabled: false, stopReason: 'done', stopPercent: 92, stoppedAt: 5 }),
    'Done — nothing required is missing (92% resolved, checked)'
  ],
  [
    running({ enabled: false, stopReason: 'no-more-improvement', stoppedAt: 5 }),
    'Stopped: another round wasn’t making it better (JEV)'
  ]
])('says in plain words why JEV stopped it', async (state, line) => {
  mocks.keepGoing = [state]
  render(<NextStepsKeepGoingStatus conversation={SOURCE} />)
  expect(await screen.findByText(line)).toBeTruthy()
})

it('tells an ad-pause stop apart from an ad-spend stop', () => {
  expect(keepGoingStopWords('needs-you-ad-pause')).toBe(
    'the next step pauses ads — you asked to approve pauses'
  )
  expect(keepGoingStopWords('needs-you-ad-spend')).toBe('the next step changes ad spend — needs you')
  expect(keepGoingStopWords('needs-you-ad-campaign-pause')).toBe(
    'the next step pauses a whole campaign — campaigns stay on; pause ad sets instead'
  )
  expect(keepGoingStopWords('needs-you-ad-enterprise')).toBe(
    'the next step pauses Enterprise ads — Enterprise ads are flagged for Sal, not paused'
  )
})

it('shows the round that paused ads without asking', async () => {
  mocks.keepGoing = [running({ lastAdPause: { at: 3, round: 2, title: 'Pause ad set 4 in SD25' } })]
  render(<NextStepsKeepGoingStatus conversation={SOURCE} />)
  expect(await screen.findByText('Round 2 paused ads: Pause ad set 4 in SD25')).toBeTruthy()
})

it.each([
  [{ enabled: true }, undefined, 'Ad pauses: default (allowed)'],
  [{ enabled: true, adPauses: 'ask-first' }, undefined, 'Ad pauses: default (ask me first)'],
  [{ enabled: true, adPauses: 'ask-first' }, 'allowed' as const, 'Ad pauses: allowed'],
  [{ enabled: true }, 'ask-first' as const, 'Ad pauses: ask me first']
])('shows this session’s ad-pause choice over the global one', async (settings, own, words) => {
  useSettings(settings)
  mocks.keepGoing = [running({ enabled: false, ...(own ? { adPauses: own } : {}) })]
  render(<NextStepsKeepGoingControl conversation={SOURCE} />)
  await waitFor(() =>
    expect(
      screen.getByRole('combobox', { name: 'Ad pauses in this session' }).textContent
    ).toContain(words)
  )
})

it('names a stop reason from a newer host in general words, never nothing', () => {
  expect(keepGoingStopWords('a-newer-reason' as NextStepKeepGoingStopReason)).toBe(
    'the host stopped it'
  )
})
