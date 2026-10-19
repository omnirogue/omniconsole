import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const QUESTION_ID = 'toolu_question_5vunCKfi'
const SIBLING_ID = 'toolu_sibling_6Cmdgag6'
const QUESTIONS = {
  questions: [
    {
      question: 'Which branch should the worker land on?',
      header: 'Branch',
      options: [{ label: 'main-next' }, { label: 'main' }],
      multiSelect: false
    }
  ]
}

async function post(server: AgentHookServer, payload: Record<string, unknown>): Promise<void> {
  const response = await postHookEvent(server, buildBody(payload))
  expect(response.status).toBe(204)
}

// The MacBook transcript of 17 Oct 2026: one assistant message with AskUserQuestion and a
// parallel ToolSearch; ToolSearch started and finished while the question was still on screen.
async function openQuestionThenRunSibling(
  server: AgentHookServer,
  withPermissionRequest: boolean
): Promise<string | undefined> {
  await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'launch the worker' })
  await post(server, {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_use_id: QUESTION_ID,
    tool_input: QUESTIONS
  })
  if (withPermissionRequest) {
    await post(server, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'AskUserQuestion',
      tool_input: QUESTIONS
    })
  }
  const [opened] = server.getStatusSnapshot()
  expect(opened).toMatchObject({ state: 'waiting', toolName: 'AskUserQuestion' })
  expect(opened.interactivePrompt).toBeDefined()
  await post(server, {
    hook_event_name: 'PreToolUse',
    tool_name: 'ToolSearch',
    tool_use_id: SIBLING_ID,
    tool_input: { query: 'select:Read' }
  })
  await post(server, {
    hook_event_name: 'PostToolUse',
    tool_name: 'ToolSearch',
    tool_use_id: SIBLING_ID,
    tool_input: { query: 'select:Read' },
    tool_response: { matches: ['Read'] }
  })
  return opened.interactivePrompt
}

describe('Claude AskUserQuestion with a parallel sibling tool call', () => {
  it.each([
    ['PreToolUse only', false],
    ['PreToolUse + PermissionRequest', true]
  ])('keeps the open question card through the sibling (%s)', async (_label, withPermission) => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const interactivePrompt = await openQuestionThenRunSibling(server, withPermission)

      const [entry] = server.getStatusSnapshot()
      expect(entry).toMatchObject({
        paneKey: PANE,
        state: 'waiting',
        agentType: 'claude',
        toolName: 'AskUserQuestion',
        interactivePrompt
      })
      expect(server.getToolUseIdForPane(PANE)).toBe(QUESTION_ID)
    } finally {
      server.stop()
    }
  })

  it('clears the card on the question’s own PostToolUse after the sibling', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await openQuestionThenRunSibling(server, true)
      await post(server, {
        hook_event_name: 'PostToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: QUESTION_ID,
        tool_input: QUESTIONS
      })

      const [entry] = server.getStatusSnapshot()
      expect(entry.state).toBe('working')
      expect(entry.interactivePrompt).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('clears the card on UserPromptSubmit after the sibling', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await openQuestionThenRunSibling(server, false)
      await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'never mind, continue' })

      const [entry] = server.getStatusSnapshot()
      expect(entry.state).toBe('working')
      expect(entry.interactivePrompt).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('clears the card on Stop after the sibling', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await openQuestionThenRunSibling(server, true)
      await post(server, { hook_event_name: 'Stop' })

      const [entry] = server.getStatusSnapshot()
      expect(entry.state).toBe('done')
      expect(entry.interactivePrompt).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('clears the card on the typed-answer fallback after the sibling', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await openQuestionThenRunSibling(server, true)
      const [waiting] = server.getStatusSnapshot()
      expect(
        server.inferQuestionAnswered({
          paneKey: waiting.paneKey,
          baselineUpdatedAt: waiting.receivedAt,
          baselineStateStartedAt: waiting.stateStartedAt,
          baselinePrompt: waiting.prompt as string,
          baselineAgentType: waiting.agentType
        })
      ).toBe(true)

      const [entry] = server.getStatusSnapshot()
      expect(entry.state).toBe('working')
      expect(entry.interactivePrompt).toBeUndefined()

      // The next message's tool work then runs normally.
      await post(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_use_id: 'toolu_next_message',
        tool_input: { file_path: '/tmp/x' }
      })
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', toolName: 'Read' })
    } finally {
      server.stop()
    }
  })

  it('leaves a real permission prompt’s handling unchanged', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'clean up' })
      await post(server, {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_use_id: 'toolu_bash',
        tool_input: { command: 'rm -rf build' }
      })
      await post(server, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 'toolu_bash',
        tool_input: { command: 'rm -rf build' }
      })

      // Approval granted: the permission's own tool resumes and the row goes back to working.
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', toolName: 'Bash' })
    } finally {
      server.stop()
    }
  })
})
