import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookRelayEnvelope, AgentHookSource } from '../shared/agent-hook-relay'
import { SOURCE_PROMPT_MAX_LENGTH } from '../shared/submitted-hook-prompt'
import { makePaneKey } from '../shared/stable-pane-id'
import { RelayAgentHookServer } from './agent-hook-server'

const paneKey = makePaneKey('tab-relay', '11111111-1111-4111-8111-111111111111')
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-user-prompt-'))
  const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
  const server = new RelayAgentHookServer({
    endpointDir: dir,
    forward,
    isPaneSurfaceRetired: () => false
  })
  cleanups.push(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  await server.start()
  return {
    forward,
    post(source: AgentHookSource, payload: Record<string, unknown>) {
      const { port, token } = server.getCoordinates()
      return fetch(`http://127.0.0.1:${port}/hook/${source}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify({
          paneKey,
          tabId: 'tab-relay',
          worktreeId: 'folder:remote',
          launchToken: 'private-launch-claim',
          payload
        })
      })
    }
  }
}

// Only a wait, a person handoff, an explicit session finish or `@next` gets a pointer.
const PROMPTS = [
  'can you make a handoff for uma as what he needs to integrate to his branch',
  'fix the bug where we close the session twice',
  'Add a Codex reviewer when done, then mark this complete.',
  'Add this to proposed: an idea for the board'
]

describe('SSH relay user prompt hooks inject no context', () => {
  it.each([
    ['claude', 'UserPromptSubmit'],
    ['codex', 'UserPromptSubmit'],
    ['kimi', 'UserPromptSubmit'],
    ['gemini', 'BeforeAgent']
  ] as const)(
    'answers a live %s prompt with 204 and still forwards it',
    async (source, eventName) => {
      for (const prompt of PROMPTS) {
        const f = await setup()
        const response = await f.post(source, { hook_event_name: eventName, prompt })
        expect(response.status).toBe(204)
        expect(await response.text()).toBe('')
        expect(f.forward.mock.calls[0][0].submittedPrompt).toBe(prompt)
      }
    }
  )

  it('points a wait request at outcome context and still forwards it', async () => {
    const f = await setup()
    const prompt = 'Wait 2 minutes, then tell me the time, then close this session'
    const response = await f.post('codex', { hook_event_name: 'UserPromptSubmit', prompt })
    expect(response.status).toBe(200)
    const reply = (await response.json()) as { hookSpecificOutput: { additionalContext: string } }
    expect(reply.hookSpecificOutput.additionalContext).toContain('outcome context --json')
    expect(f.forward.mock.calls[0][0].submittedPrompt).toBe(prompt)
  })

  it('answers an oversized prompt with 204 and records no source', async () => {
    const f = await setup()
    const response = await f.post('gemini', {
      hook_event_name: 'BeforeAgent',
      prompt: `Add a Codex reviewer.${'x'.repeat(SOURCE_PROMPT_MAX_LENGTH)}`
    })
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(f.forward.mock.calls[0][0].submittedPrompt).toBeUndefined()
  })
})
