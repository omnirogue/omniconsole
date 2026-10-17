import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { GOOD_PANE, PANE } from './server.test-fixtures'
import {
  asyncQuestionAnswerClaimed,
  asyncQuestionAnswerTaken,
  claimAsyncQuestionAnswer,
  resetAsyncQuestionAnswerClaimsForTests
} from '../runtime/async-question-answer-claims'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

const ASK = JSON.stringify({
  delivery: 'async',
  asyncQuestions: [{ question: 'Which color?', multiSelect: false, options: [] }]
})
const SELECTOR = JSON.stringify({
  questions: [{ question: 'Ship?', multiSelect: false, options: [{ label: 'Yes' }] }]
})

describe('an async question whose Codex exited', () => {
  let userDataPath: string

  beforeEach(() => {
    _internals.resetCachesForTests()
    userDataPath = mkdtempSync(join(tmpdir(), 'omni-async-question-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  const report = (server: AgentHookServer, paneKey: string, payload: Record<string, unknown>) =>
    server.ingestRemote(
      {
        paneKey,
        tabId: paneKey.split(':')[0],
        worktreeId: 'wt-1',
        payload: { prompt: 'ask me', agentType: 'codex', ...payload }
      } as Parameters<AgentHookServer['ingestRemote']>[0],
      'conn-1'
    )
  const rowOf = (server: AgentHookServer, paneKey: string) =>
    server.getStatusSnapshot().find((entry) => entry.paneKey === paneKey)

  it('keeps the finished turn and loses only the question', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      report(server, PANE, { state: 'done', interactivePrompt: ASK })
      report(server, GOOD_PANE, { state: 'waiting', interactivePrompt: SELECTOR })
      expect(server.dropAsyncQuestion(PANE)).toBe(true)
      expect(rowOf(server, PANE)).toMatchObject({ state: 'done', prompt: 'ask me' })
      expect(rowOf(server, PANE)?.interactivePrompt).toBeUndefined()
      expect(server.dropAsyncQuestion(PANE)).toBe(false)
      // A selector question holds its agent; only an async one can outlive it.
      expect(server.dropAsyncQuestion(GOOD_PANE)).toBe(false)
      expect(rowOf(server, GOOD_PANE)?.interactivePrompt).toBe(SELECTOR)
    } finally {
      server.stop()
    }
  })

  it('comes back from disk after a restart, and still drops', async () => {
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath })
    report(first, PANE, { state: 'done', interactivePrompt: ASK })
    first.flushStatusPersistSync()
    first.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      expect(rowOf(server, PANE)).toMatchObject({ state: 'done', interactivePrompt: ASK })
      expect(rowOf(server, PANE)?.restoredUnconfirmed).toBeUndefined()
      expect(server.dropAsyncQuestion(PANE)).toBe(true)
      expect(rowOf(server, PANE)?.interactivePrompt).toBeUndefined()
    } finally {
      server.stop()
    }
  })
})

describe('an answer on its way to an async question', () => {
  let userDataPath: string

  beforeEach(() => {
    _internals.resetCachesForTests()
    resetAsyncQuestionAnswerClaimsForTests()
    userDataPath = mkdtempSync(join(tmpdir(), 'omni-async-claim-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('is settled by Codex’s own report of the turn it started, never by a child’s', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    const promptSubmit = (extra: Record<string, unknown>) =>
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: PANE.split(':')[0],
          worktreeId: 'wt-1',
          hookEventName: 'UserPromptSubmit',
          payload: { state: 'working', prompt: '> Which color?\n\nRed', agentType: 'codex' },
          ...extra
        } as Parameters<AgentHookServer['ingestRemote']>[0],
        'conn-1'
      )
    try {
      expect(claimAsyncQuestionAnswer(PANE, ['Which color?'], 'card-1')).toBe(true)
      promptSubmit({ toolAgentId: 'child-1' })
      expect(asyncQuestionAnswerClaimed(PANE, 'Which color?')).toBe(true)
      promptSubmit({})
      expect(asyncQuestionAnswerClaimed(PANE, 'Which color?')).toBe(false)
      expect(asyncQuestionAnswerTaken('card-1')).toBe(true)
    } finally {
      server.stop()
    }
  })
})
