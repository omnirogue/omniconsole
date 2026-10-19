import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const FRESH_PANE_KEY = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')
const LAUNCHED = '01a14edb-fd51-73f0-b055-af5352857fcb'
const MEMORY_THREAD = '01a14edc-4512-76a1-9c79-0db49656ed7b'
const NEXT_SAVED = '01a14edd-0000-7000-8000-000000000001'

describe('AgentHookServer Codex threads that are never saved', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  function rollout(id: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-side-thread-'))
    dirs.push(dir)
    const path = join(dir, `rollout-2026-10-18T07-53-22-${id}.jsonl`)
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`)
    return path
  }

  async function post(
    server: AgentHookServer,
    paneKey: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const env = server.buildPtyEnv()
    const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify({ paneKey, tabId: paneKey.split(':')[0], worktreeId: 'wt-1', payload })
    })
    expect(response.status).toBe(204)
  }

  function sessionOf(server: AgentHookServer, paneKey: string): string | undefined {
    return server.getProviderSessionIdentities().find((identity) => identity.paneKey === paneKey)
      ?.sessionId
  }

  it('keeps the launched conversation when Codex memory writing reports from its own thread', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await post(server, PANE_KEY, {
        hook_event_name: 'Stop',
        session_id: LAUNCHED,
        transcript_path: rollout(LAUNCHED),
        last_assistant_message: 'WAITING_FOR_STEP2'
      })
      const finished = server.getStatusSnapshot().find((row) => row.paneKey === PANE_KEY)?.state
      expect(sessionOf(server, PANE_KEY)).toBe(LAUNCHED)

      // Why: the shape seen on 18 Oct 2026: another id, no transcript_path, the memory prompt.
      await post(server, PANE_KEY, {
        hook_event_name: 'PostToolUse',
        session_id: MEMORY_THREAD,
        transcript_path: null,
        prompt: '## Memory Writing Agent: Phase 2 (Consolidation)',
        tool_name: 'Bash',
        tool_use_id: 'exec-8f384928'
      })
      expect(sessionOf(server, PANE_KEY)).toBe(LAUNCHED)
      expect(server.getStatusSnapshot().find((row) => row.paneKey === PANE_KEY)?.state).toBe(
        finished
      )

      // A new saved conversation in the same tab (a /new) still takes over.
      await post(server, PANE_KEY, {
        hook_event_name: 'UserPromptSubmit',
        session_id: NEXT_SAVED,
        transcript_path: rollout(NEXT_SAVED),
        prompt: 'next task'
      })
      expect(sessionOf(server, PANE_KEY)).toBe(NEXT_SAVED)
    } finally {
      server.stop()
    }
  })

  it('accepts a first report without a transcript path in a tab that holds no conversation yet', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await post(server, FRESH_PANE_KEY, {
        hook_event_name: 'SessionStart',
        session_id: LAUNCHED,
        source: 'startup'
      })
      expect(sessionOf(server, FRESH_PANE_KEY)).toBe(LAUNCHED)
    } finally {
      server.stop()
    }
  })
})
