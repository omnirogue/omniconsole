import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmPaneConversation, SESSION_RESUME_CONFIRM_TIMEOUT_MS } from './session-restart-proof'

const ID = '2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c'
const reference = { sessionId: ID, hostId: 'local', transcriptPath: null }

function runtime(reports: { id: string; transcriptPath?: string }[][]) {
  let call = 0
  return {
    getReportedProviderSessionsForPane: vi.fn(() => reports[Math.min(call++, reports.length - 1)])
  } as never
}

afterEach(() => {
  vi.useRealTimers()
})

describe('confirmPaneConversation', () => {
  it('confirms only once the pane’s agent hooks report the same conversation', async () => {
    vi.useFakeTimers()
    const verdict = confirmPaneConversation(
      runtime([[], [], [{ id: ID }]]),
      reference,
      async () => 'tab-7:leaf-7'
    )
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(verdict).resolves.toEqual({ state: 'same', paneKey: 'tab-7:leaf-7' })
  })

  it('names a different conversation the agent reported', async () => {
    await expect(
      confirmPaneConversation(runtime([[{ id: 'fresh-1' }]]), reference, async () => 'tab-7:leaf-7')
    ).resolves.toEqual({ state: 'different', reported: 'fresh-1' })
  })

  it('stays unconfirmed when no hook reports within the window', async () => {
    vi.useFakeTimers()
    const verdict = confirmPaneConversation(runtime([[]]), reference, async () => 'tab-7:leaf-7')
    await vi.advanceTimersByTimeAsync(SESSION_RESUME_CONFIRM_TIMEOUT_MS + 1_000)
    await expect(verdict).resolves.toEqual({ state: 'unconfirmed' })
  })
})
