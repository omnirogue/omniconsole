import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../../shared/session-chain-types'
import {
  endsWithOwnershipHandoff,
  finishSessionChainSource,
  isPaneGoneError,
  planSessionTabIds
} from './session-chain-ending'

const mocks = vi.hoisted(() => ({
  waits: vi.fn(),
  finished: vi.fn(),
  returned: vi.fn(),
  close: vi.fn(async (_tabId: string, _options: unknown): Promise<boolean | null> => true),
  open: vi.fn((_tabId: string) => true),
  busy: vi.fn((_tabId: string) => false),
  toast: vi.fn()
}))
vi.mock('@/lib/session-chain-blocks', () => ({
  waitForFinishedStops: (_access: unknown, chain: unknown, keys: unknown, signal: unknown) =>
    mocks.waits(chain, keys, signal)
}))
vi.mock('@/lib/close-session-tab', () => ({
  closeSessionTab: mocks.close,
  sessionTabIsOpen: mocks.open,
  sessionTabHasUnfinishedAgent: mocks.busy
}))
vi.mock('sonner', () => ({ toast: { success: mocks.toast } }))
vi.mock('@/store/wait-later-store', () => ({
  useWaitLater: { getState: () => ({ setFinished: mocks.finished, setReturned: mocks.returned }) }
}))
vi.mock('@/lib/session-chain-support', () => ({ sourcePaneKeysForStep: () => ['next:pane'] }))

const SOURCE_LEAF = '11111111-1111-4111-8111-111111111111'
const NEXT_LEAF = '22222222-2222-4222-8222-222222222222'

function chain(steps: SessionChain['steps'], end: 'me' | 'done' = 'me'): SessionChain {
  return {
    id: 'chn',
    sourcePaneKey: `tab-source:${SOURCE_LEAF}`,
    steps,
    end,
    state: 'waiting'
  } as unknown as SessionChain
}
const agentStep = {
  kind: 'agent',
  id: 'a',
  agent: 'claude',
  prompt: 'x',
  status: 'launched',
  launchedPaneKey: `tab-next:${NEXT_LEAF}`
}
const handoff = (action?: 'review') => ({
  kind: 'handoff',
  id: 'h',
  status: 'done',
  handoff: { recipients: [{ employeeId: 'emp_uma', name: 'Uma' }], ...(action ? { action } : {}) }
})
const access = (current: SessionChain) => ({ getChain: () => current, update: vi.fn() })
const signal = () => new AbortController().signal

describe('chain ending rules', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.close.mockResolvedValue(true)
    mocks.open.mockReturnValue(true)
    mocks.busy.mockReturnValue(false)
  })
  it('only a pane that cannot be found counts as gone', () => {
    expect(isPaneGoneError(new Error('The session pane could not be found.'))).toBe(true)
    expect(isPaneGoneError(new Error('Source session exited with code 1'))).toBe(false)
    expect(isPaneGoneError('nope')).toBe(false)
  })
  it('a person who owns the work ends the plan; a review request does not', () => {
    expect(endsWithOwnershipHandoff(chain([agentStep, handoff()] as never))).toBe(true)
    expect(endsWithOwnershipHandoff(chain([agentStep, handoff('review')] as never))).toBe(false)
    expect(endsWithOwnershipHandoff(chain([handoff(), agentStep] as never))).toBe(false)
  })
  it('never hands a conversation back that a person now owns', async () => {
    const handed = chain([agentStep, handoff()] as never)
    await finishSessionChainSource(handed, signal(), access(handed))
    expect(mocks.waits).not.toHaveBeenCalled()
    expect(mocks.returned).not.toHaveBeenCalled()
    expect(mocks.finished).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })
  it('a last agent that failed fails the plan instead of finishing or closing it', async () => {
    mocks.waits.mockRejectedValueOnce(new Error('Source session exited with code 1'))
    const failing = chain([agentStep] as never, 'done')
    await expect(finishSessionChainSource(failing, signal(), access(failing))).rejects.toThrow(
      'exited with code 1'
    )
    expect(mocks.finished).not.toHaveBeenCalled()
    expect(mocks.returned).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })
  it('a pane the person closed still finishes the plan', async () => {
    mocks.waits.mockRejectedValueOnce(new Error('The session pane could not be found.'))
    const gone = chain([agentStep] as never, 'me')
    await finishSessionChainSource(gone, signal(), access(gone))
    expect(mocks.returned).toHaveBeenCalledWith(`pane:tab-source:${SOURCE_LEAF}`, expect.any(Date))
    expect(mocks.close).not.toHaveBeenCalled()
  })
  it('✓ closes every session the plan ran in, once the work has finished', async () => {
    mocks.waits.mockResolvedValueOnce([{ handle: 'next', exited: false }])
    const ending = chain([agentStep] as never, 'done')
    await finishSessionChainSource(ending, signal(), access(ending))
    expect(mocks.finished).toHaveBeenCalledWith(`pane:tab-source:${SOURCE_LEAF}`, expect.any(Date))
    expect(mocks.close.mock.calls.map(([tabId, options]) => [tabId, options])).toEqual([
      ['tab-source', { rejectPinned: true }],
      ['tab-next', { rejectPinned: true }]
    ])
    expect(mocks.toast).toHaveBeenCalledWith('Finished and closed. Reopen it from Recently closed.')
    expect(mocks.returned).not.toHaveBeenCalled()
  })
  it('↩ Back to me hands the work back and closes nothing', async () => {
    mocks.waits.mockResolvedValueOnce([{ handle: 'next', exited: false }])
    const back = chain([agentStep] as never, 'me')
    await finishSessionChainSource(back, signal(), access(back))
    expect(mocks.returned).toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })
  it('keeps a tab open where an agent is still busy, or that stays pinned, and says so', async () => {
    mocks.waits.mockResolvedValueOnce([{ handle: 'next', exited: false }])
    mocks.busy.mockImplementation((tabId) => tabId === 'tab-source')
    mocks.close.mockResolvedValueOnce(false)
    const ending = chain([agentStep] as never, 'done')
    await finishSessionChainSource(ending, signal(), access(ending))
    expect(mocks.close.mock.calls.map(([tabId]) => tabId)).toEqual(['tab-next'])
    expect(mocks.toast).toHaveBeenCalledWith(
      'Finished. 0 closed; 2 stayed open because it is pinned or an agent there is busy.'
    )
  })
  it('never closes anything when the plan was cancelled while it waited', async () => {
    const controller = new AbortController()
    mocks.waits.mockImplementationOnce(async () => {
      controller.abort()
      return []
    })
    const ending = chain([agentStep] as never, 'done')
    await finishSessionChainSource(ending, controller.signal, access(ending))
    expect(mocks.finished).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })
  it('lists the tab of the source and of every launched session once, skipping unknown panes', () => {
    const plan = chain(
      [
        agentStep,
        { ...agentStep, id: 'b', launchedPaneKey: `tab-next:${SOURCE_LEAF}` },
        { ...agentStep, id: 'c', launchedPaneKey: null },
        handoff('review')
      ] as never,
      'done'
    )
    expect(planSessionTabIds(plan)).toEqual(['tab-source', 'tab-next'])
  })
})
