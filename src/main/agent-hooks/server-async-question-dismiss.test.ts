import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pendingSessionAsk } from '../../shared/session-questions'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, GOOD_PANE, PANE, type Body } from './server.test-fixtures'
import {
  claimAsyncQuestionAnswer,
  resetAsyncQuestionAnswerClaimsForTests
} from '../runtime/async-question-answer-claims'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

const INPUT = {
  questions: [
    {
      title: 'May I restart the daemon on the Mac Studio?',
      options: ['Restart', 'Keep']
    },
    { title: 'Which monitor should I launch?' }
  ]
}

describe('a card dismissing an async question', () => {
  let userDataPath: string

  beforeEach(() => {
    _internals.resetCachesForTests()
    resetAsyncQuestionAnswerClaimsForTests()
    // Why: the hook pid fence asks whether pid 4242 is alive.
    vi.spyOn(process, 'kill').mockReturnValue(true)
    userDataPath = mkdtempSync(join(tmpdir(), 'omni-async-dismiss-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  const codex = (server: AgentHookServer, payload: Record<string, unknown>) =>
    postHookEvent(server, { ...buildBody(payload), agentPid: 4242 } as Body, '/hook/codex')
  const askThenFinish = async (server: AgentHookServer) => {
    await codex(server, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'fix the daemon'
    })
    await codex(server, {
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input_async',
      tool_input: INPUT,
      tool_use_id: 'call_1'
    })
    await codex(server, {
      hook_event_name: 'PostToolUse',
      tool_name: 'request_user_input_async',
      tool_input: INPUT,
      tool_response: '{"accepted":true}',
      tool_use_id: 'call_1'
    })
    await codex(server, {
      hook_event_name: 'Stop',
      last_assistant_message: 'Fixed.'
    })
  }
  const rowOf = (server: AgentHookServer, paneKey: string = PANE) =>
    server.getStatusSnapshot().find((entry) => entry.paneKey === paneKey)
  const open = (server: AgentHookServer) => {
    const row = rowOf(server)
    return row ? (pendingSessionAsk(row)?.questions.map((question) => question.question) ?? []) : []
  }

  it('preserves process, launch, occurrence and observed evidence on partial and full dismissal', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    const send = (payload: Record<string, unknown>) => {
      const body = {
        ...buildBody(payload, { launchToken: 'question-launch' }),
        agentPid: process.pid
      }
      return postHookEvent(server, body, '/hook/codex')
    }
    try {
      await send({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the daemon' })
      await send({
        hook_event_name: 'PreToolUse',
        tool_name: 'request_user_input_async',
        tool_input: INPUT,
        tool_use_id: 'call_1'
      })
      await send({ hook_event_name: 'Stop', last_assistant_message: 'Asked.' })
      const before = server._getStateForTests().lastStatusByPaneKey.get(PANE)!
      const shownBefore = rowOf(server)!
      const questions = pendingSessionAsk(shownBefore)!.questions
      expect(shownBefore).toMatchObject({ agentPid: process.pid, launchToken: 'question-launch' })
      expect(shownBefore.observation?.kind).toBe('transition')
      expect(questions[1]?.askedAt).toEqual(expect.any(Number))
      vi.spyOn(Date, 'now').mockReturnValue(shownBefore.receivedAt + 60 * 60 * 1_000)

      expect(server.dismissAsyncQuestions(PANE, [questions[0]!])).toBe(true)
      const partial = server._getStateForTests().lastStatusByPaneKey.get(PANE)!
      expect(partial).toEqual({
        ...before,
        payload: { ...before.payload, interactivePrompt: expect.any(String) }
      })
      expect(pendingSessionAsk(rowOf(server)!)!.questions).toEqual([questions[1]!])
      expect(server.getLocalAgentPidForPane(PANE)).toBe(process.pid)

      expect(server.dismissAsyncQuestions(PANE, questions)).toBe(true)
      const { interactivePrompt: _ask, ...completedPayload } = before.payload
      expect(server._getStateForTests().lastStatusByPaneKey.get(PANE)).toEqual({
        ...before,
        payload: completedPayload
      })
      expect(server.getLocalAgentPidForPane(PANE)).toBe(process.pid)
      expect(rowOf(server)).toMatchObject({
        receivedAt: shownBefore.receivedAt,
        evidenceObservedAt: shownBefore.evidenceObservedAt,
        stateStartedAt: shownBefore.stateStartedAt,
        observation: shownBefore.observation
      })
    } finally {
      server.stop()
    }
  })

  it('leaves the row for good, through later events and a restart', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await askThenFinish(server)
      const shown = pendingSessionAsk(rowOf(server)!)!.questions
      expect(shown).toHaveLength(2)
      expect(server.dismissAsyncQuestions(PANE, [shown[0]!])).toBe(true)
      expect(open(server)).toEqual(['Which monitor should I launch?'])
      // The question left on the row stays answerable: the answer path proves Codex by this pid.
      expect(rowOf(server)?.agentPid).toBe(4242)
      expect(server.getLocalAgentPidForPane(PANE)).toBe(4242)
      expect(server.dismissAsyncQuestions(PANE, shown)).toBe(true)
      expect(rowOf(server)).toMatchObject({
        state: 'done',
        prompt: 'fix the daemon'
      })
      expect(rowOf(server)?.interactivePrompt).toBeUndefined()
      // A later hook event rebuilds the row from Codex's state: nothing comes back.
      await codex(server, {
        hook_event_name: 'Stop',
        last_assistant_message: 'Fixed.'
      })
      expect(open(server)).toEqual([])
      expect(server.dismissAsyncQuestions(PANE, shown)).toBe(false)
      server.flushStatusPersistSync()
    } finally {
      server.stop()
    }
    const restarted = new AgentHookServer()
    await restarted.start({ env: 'production', userDataPath })
    try {
      expect(open(restarted)).toEqual([])
    } finally {
      restarted.stop()
    }
  })

  it('drops the questions an answer skipped once Codex reports taking that answer', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await askThenFinish(server)
      const [restart, monitor] = pendingSessionAsk(rowOf(server)!)!.questions
      // The card answered the first and skipped the second; its cancel may never see the receipt.
      expect(claimAsyncQuestionAnswer(PANE, [restart!.question], 'card-1', [monitor!])).toBe(true)
      await codex(server, {
        hook_event_name: 'UserPromptSubmit',
        prompt: `> ${restart!.question}\n\nRestart`
      })
      await codex(server, { hook_event_name: 'Stop', last_assistant_message: 'Restarted.' })
      expect(open(server)).toEqual([])
    } finally {
      server.stop()
    }
  })

  it("keeps a restored row's pid as data without making it the pane's owner", async () => {
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath })
    await askThenFinish(first)
    first.flushStatusPersistSync()
    first.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const shown = pendingSessionAsk(rowOf(server)!)!.questions
      expect(server.getLocalAgentPidForPane(PANE)).toBeUndefined()
      expect(server.dismissAsyncQuestions(PANE, [shown[0]!])).toBe(true)
      expect(open(server)).toEqual([shown[1]!.question])
      // Why: the pid may since belong to another process; only a live hook may claim the pane.
      expect(server.getLocalAgentPidForPane(PANE)).toBeUndefined()
      expect(rowOf(server)?.agentPid).toBe(4242)
    } finally {
      server.stop()
    }
  })

  it('is refused while an answer to it is on its way', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await askThenFinish(server)
      const shown = pendingSessionAsk(rowOf(server)!)!.questions
      expect(claimAsyncQuestionAnswer(PANE, [shown[0]!.question], 'card-1')).toBe(true)
      expect(server.dismissAsyncQuestions(PANE, [shown[0]!])).toBe(false)
      expect(open(server)).toHaveLength(2)
    } finally {
      server.stop()
    }
  })

  it('is refused over SSH, whose relay owns the question', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    const ask = JSON.stringify({
      delivery: 'async',
      asyncQuestions: [
        {
          question: 'Which color?',
          multiSelect: false,
          options: [],
          askedAt: 1
        }
      ]
    })
    try {
      server.ingestRemote(
        {
          paneKey: GOOD_PANE,
          tabId: GOOD_PANE.split(':')[0],
          worktreeId: 'wt-1',
          payload: {
            state: 'done',
            prompt: 'ask me',
            agentType: 'codex',
            interactivePrompt: ask
          }
        } as Parameters<AgentHookServer['ingestRemote']>[0],
        'conn-1'
      )
      expect(
        server.dismissAsyncQuestions(GOOD_PANE, [{ question: 'Which color?', askedAt: 1 }])
      ).toBe(false)
      expect(rowOf(server, GOOD_PANE)?.interactivePrompt).toBe(ask)
    } finally {
      server.stop()
    }
  })
})
