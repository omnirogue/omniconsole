import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

// Only a wait, a person handoff, an explicit session finish or `@next` gets a pointer at
// `outcome context`; these real prompts, which a retired classifier hijacked, stay ordinary work.
const PROMPTS = [
  'can you make a handoff for uma as what he needs to integrate to his branch',
  'fix the bug where we close the session twice',
  'When you are done, add a Codex reviewer, then hand off the files and the full conversation to Uma, and mark this complete.',
  'Add this to proposed: an idea for the board'
]

let server: AgentHookServer

beforeEach(async () => {
  _internals.resetCachesForTests()
  server = new AgentHookServer()
  await server.start({ env: 'production' })
})

afterEach(() => {
  server.stop()
  vi.restoreAllMocks()
})

describe('user prompt hooks inject no context', () => {
  it.each(PROMPTS)(
    'answers a Claude UserPromptSubmit with 204 and records status: %s',
    async (prompt) => {
      const response = await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt }, { launchToken: 'launch-1' })
      )
      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
      expect(server.getStatusSnapshotForPane(PANE)).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'working', prompt })
      ])
    }
  )

  it.each([
    ['codex', 'UserPromptSubmit'],
    ['kimi', 'UserPromptSubmit'],
    ['gemini', 'BeforeAgent']
  ])('answers a %s prompt hook with 204', async (source, hookEventName) => {
    for (const prompt of PROMPTS) {
      const response = await postHookEvent(
        server,
        buildBody({ hook_event_name: hookEventName, prompt }, { launchToken: `launch-${source}` }),
        `/hook/${source}`
      )
      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
    }
  })

  it.each([
    ['claude', 'UserPromptSubmit'],
    ['gemini', 'BeforeAgent']
  ])(
    'points a %s wait request at outcome context and still records it',
    async (source, hookEventName) => {
      const prompt = 'Wait for Uma to approve on Slack, then close this session'
      const response = await postHookEvent(
        server,
        buildBody({ hook_event_name: hookEventName, prompt }, { launchToken: `launch-${source}` }),
        `/hook/${source}`
      )
      expect(response.status).toBe(200)
      const reply = (await response.json()) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string }
      }
      expect(reply.hookSpecificOutput.hookEventName).toBe(hookEventName)
      expect(reply.hookSpecificOutput.additionalContext).toContain('outcome context --json')
      expect(server.getStatusSnapshotForPane(PANE)).toEqual([
        expect.objectContaining({ paneKey: PANE, prompt })
      ])
    }
  )
})
