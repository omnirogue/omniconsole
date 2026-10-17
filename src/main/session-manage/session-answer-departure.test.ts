import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { confirmSessionPromptExit } from './session-answer-confirmation'
import { readSessionAnswerDeparture } from './session-answer-departure'
import {
  answerSession,
  withSessionAnswerLock,
  type SessionAnswerDeps,
  type SessionAnswerReading
} from './session-manage-answer'
import { agentProcess, manageEntry, sidebarRow } from './session-manage-test-fixtures'
import { parseSessionPromptScreen } from './session-prompt-screen'
import type { SessionPrompt } from './session-prompt'

afterEach(() => vi.useRealTimers())

describe('verified answer quarantine departure', () => {
  it('requires repeated positive screen departure before a later answer can pass quarantine', async () => {
    vi.useFakeTimers()
    const screen = 'Bash command\n  pwd\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel'
    const prompt: SessionPrompt = {
      ...parseSessionPromptScreen('claude', screen)!,
      delivery: { kind: 'pty', handle: 'term_1', ptyId: 'pty-1', screen }
    }
    const row = sidebarRow()
    const initial: SessionAnswerReading = {
      entry: manageEntry({
        state: 'awaiting-user',
        stateBasis: 'screen',
        kind: 'terminal',
        terminal: 'term_1',
        agentForeground: true
      }),
      source: { kind: 'pty', worktreeId: row.worktreeId, paneKey: row.paneKey! },
      prompt,
      agentProcess: agentProcess({ ptyId: 'pty-1' })
    }
    let reading = initial
    let tail = screen.split('\n')
    const runtime = {
      readTerminal: vi.fn(async () => ({ source: 'screen', tail }))
    } as unknown as Pick<OrcaRuntimeService, 'readTerminal'>
    const read = async () => reading
    const confirmDeparture = vi.fn(
      async () =>
        (await confirmSessionPromptExit(() => readSessionAnswerDeparture(read, runtime, row)))
          .status === 'confirmed'
    )
    const deliver = vi.fn<SessionAnswerDeps['deliver']>(async () => ({ status: 'confirmed' }))
    deliver.mockRejectedValueOnce(new Error('lost write'))
    const deps: SessionAnswerDeps = {
      read,
      confirmDeparture,
      recheck: async () => {},
      stopKeepGoing: () => false,
      deliver
    }
    const answer = (dryRun = false) =>
      withSessionAnswerLock('verified-departure-test', (lock) =>
        answerSession(deps, {
          actor: { kind: 'cli' },
          expect: prompt.ask.fingerprint,
          answer: { kind: 'allow' },
          dryRun,
          lock
        })
      )
    await expect(answer()).rejects.toThrow('may already have reached')
    reading = { ...initial, entry: { ...initial.entry, state: 'working', stateBasis: 'hook' } }
    await expect(answer()).rejects.toThrow('not awaiting-user')
    expect(confirmDeparture).not.toHaveBeenCalled()
    reading = { ...reading, prompt: undefined }
    const stillVisible = answer().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(2000)
    expect(((await stillVisible) as Error).message).toContain('not awaiting-user')
    reading = initial
    await expect(answer()).rejects.toThrow('may already have reached it')
    reading = {
      ...initial,
      prompt: undefined,
      entry: { ...initial.entry, state: 'working', stateBasis: 'hook' }
    }
    tail = ['• Working (1s • esc to interrupt)']
    await expect(answer(true)).rejects.toThrow('not awaiting-user')
    expect(confirmDeparture).toHaveBeenCalledOnce()
    let finished = false
    const recovered = answer().catch((error: unknown) => {
      finished = true
      return error
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(((await recovered) as Error).message).toContain('not awaiting-user')
    reading = initial
    await expect(answer()).resolves.toMatchObject({ delivery: 'confirmed' })
    expect(deliver).toHaveBeenCalledTimes(2)
  })
})

it('never releases a structured pending answer from optimistic journal-derived working state', async () => {
  const row = sidebarRow({ kind: 'structured', structuredSessionId: 'chat' })
  const read = async (): Promise<SessionAnswerReading> => ({
    entry: manageEntry({ state: 'working', stateBasis: 'chat-host', kind: 'chat', terminal: null }),
    source: {
      kind: 'structured',
      worktreeId: row.worktreeId,
      paneKey: row.paneKey!,
      sessionId: 'chat'
    },
    prompt: undefined,
    agentProcess: null
  })
  const runtime = { readTerminal: vi.fn() } as unknown as Pick<OrcaRuntimeService, 'readTerminal'>
  await expect(readSessionAnswerDeparture(read, runtime, row)).resolves.toEqual({
    kind: 'unreadable',
    reason: 'its chat host has no verified provider departure receipt'
  })
  expect(runtime.readTerminal).not.toHaveBeenCalled()
})
