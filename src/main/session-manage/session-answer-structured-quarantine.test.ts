import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersistentSessionAnswerQuarantine } from './session-answer-quarantine'
import { structuredAnswerQuarantineKey } from './session-manage-answer-lock'
import {
  answerSession,
  withSessionAnswerLock,
  type SessionAnswerDeps
} from './session-manage-answer'
import { describeSessionPrompt, type SessionPrompt } from './session-prompt'
import { manageEntry } from './session-manage-test-fixtures'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'structured-answer-'))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
function question(itemId: string, revision = 1, fence = 1): SessionPrompt {
  const options = [{ n: 1, label: 'Existing parser', value: `${itemId}:existing` }]
  const text = `Which parser for ${itemId}?`
  return {
    ask: describeSessionPrompt('question', text, options, true),
    options,
    readable: true,
    subject: text,
    commandText: [],
    delivery: { kind: 'structured', sessionId: 'chat', itemId, revision, fence }
  }
}
function fixture() {
  let current = question('one')
  const pane = 'workspace:pane'
  const deliver = vi.fn<SessionAnswerDeps['deliver']>(async (prompt) => {
    expect(prompt.delivery.kind).toBe('structured')
    if (prompt.delivery.kind === 'structured') {
      expect(
        new PersistentSessionAnswerQuarantine(directory).has(
          structuredAnswerQuarantineKey('chat', prompt.delivery.itemId)
        )
      ).toBe(true)
    }
    return { status: 'recorded' }
  })
  const deps: SessionAnswerDeps = {
    read: async () => ({
      entry: manageEntry({ kind: 'chat', state: 'awaiting-user', stateBasis: 'chat-host' }),
      source: { kind: 'structured', sessionId: 'chat', paneKey: 'pane', worktreeId: 'workspace' },
      prompt: current,
      agentProcess: null
    }),
    recheck: async () => {},
    stopKeepGoing: () => false,
    deliver
  }
  return {
    deliver,
    pane,
    setPrompt: (prompt: SessionPrompt) => {
      current = prompt
    },
    answer: (key = pane) =>
      withSessionAnswerLock(
        key,
        (lock) =>
          answerSession(deps, {
            actor: { kind: 'cli' },
            expect: current.ask.fingerprint,
            answer: { kind: 'choose', choice: 1 },
            dryRun: false,
            lock
          }),
        new PersistentSessionAnswerQuarantine(directory)
      )
  }
}

describe('structured per-item uncertainty', () => {
  it('answers sequential distinct questions while retaining both unknown records across restart', async () => {
    const { answer, setPrompt, deliver } = fixture()
    await expect(answer()).resolves.toMatchObject({ delivery: 'recorded' })
    setPrompt(question('two'))
    await expect(answer()).resolves.toMatchObject({ delivery: 'recorded' })
    const restarted = new PersistentSessionAnswerQuarantine(directory)
    expect(restarted.has(structuredAnswerQuarantineKey('chat', 'one'))).toBe(true)
    expect(restarted.has(structuredAnswerQuarantineKey('chat', 'two'))).toBe(true)
    expect(deliver).toHaveBeenCalledTimes(2)
  })
  it('never retries the same provider item after revision, fence, text or pane changes', async () => {
    const { answer, setPrompt, deliver } = fixture()
    await answer()
    await expect(answer()).rejects.toThrow('may already have reached')
    const revised = question('one', 9, 7)
    revised.ask = {
      ...revised.ask,
      text: 'A different displayed question',
      fingerprint: 'new-fingerprint'
    }
    setPrompt(revised)
    await expect(answer('other-workspace:other-pane')).rejects.toThrow('may already have reached')
    expect(deliver).toHaveBeenCalledOnce()
  })
  it('retains legacy pane-wide uncertainty conservatively', async () => {
    const { answer, pane, deliver } = fixture()
    new PersistentSessionAnswerQuarantine(directory).add(pane)
    await expect(answer()).rejects.toThrow('may already have reached')
    expect(deliver).not.toHaveBeenCalled()
  })
})
