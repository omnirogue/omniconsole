import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const PANE_KEY = makePaneKey('tab-question', '11111111-1111-4111-8111-111111111111')

function askAndGetRequest(
  server: AgentHookServer,
  agentType: string,
  toolName: string,
  intent: 'plain-escape' | 'ctrl-c' = 'plain-escape'
): Parameters<AgentHookServer['inferInterrupt']>[0] {
  server.ingestRemote(
    {
      paneKey: PANE_KEY,
      tabId: 'tab-question',
      worktreeId: 'worktree-question',
      hookEventName: agentType === 'gemini' ? 'BeforeTool' : 'PermissionRequest',
      payload: {
        state: 'waiting',
        prompt: 'ask me',
        agentType,
        toolName,
        interactivePrompt: '{"optionOnlyAsk":{"questions":[{"question":"Which fruit?"}]}}'
      }
    },
    'connection-1'
  )
  const [entry] = server.getStatusSnapshot()
  return {
    paneKey: entry.paneKey,
    baselineUpdatedAt: entry.receivedAt,
    baselineStateStartedAt: entry.stateStartedAt,
    baselinePrompt: entry.prompt as string,
    baselineAgentType: entry.agentType,
    intent
  }
}

describe('Escape on a Gemini or Qwen Code question', () => {
  it.each([
    ['gemini', 'ask_user'],
    ['qwen-code', 'ask_user_question']
  ])('%s: asked, then no further hook — Escape ends the wait and its card', (agent, tool) => {
    const server = new AgentHookServer()
    const request = askAndGetRequest(server, agent, tool)
    // Asked, and the CLI sends nothing more: the question stays pending on its own.
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ state: 'waiting', toolName: tool })
    ])

    expect(server.inferInterrupt(request)).toBe(true)
    const [entry] = server.getStatusSnapshot()
    expect(entry).toMatchObject({ state: 'done', agentType: agent, interrupted: true })
    expect(entry.interactivePrompt).toBeUndefined()
  })

  it.each([
    ['qwen-code', 'run_shell_command', 'plain-escape'],
    ['gemini', 'ask_user', 'ctrl-c'],
    ['hermes', 'clarify', 'plain-escape']
  ] as const)('keeps a %s %s wait on %s', (agent, tool, intent) => {
    const server = new AgentHookServer()
    expect(server.inferInterrupt(askAndGetRequest(server, agent, tool, intent))).toBe(false)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ state: 'waiting', toolName: tool })
    ])
  })
})
