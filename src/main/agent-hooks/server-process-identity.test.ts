import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpoolRecord } from '../../shared/agent-hook-spool'

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

async function post(pid: number | undefined, id: string, hook = 'SessionStart', host?: string) {
  const env = server.buildPtyEnv()
  await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify({
      paneKey: PANE,
      agentPid: pid,
      agentPidHost: host,
      payload: { hook_event_name: hook, session_id: id, prompt: id, source: 'startup' }
    })
  })
}

describe('HTTP PID fence before normalization', () => {
  it.each(['http', 'spool'])(
    'rejects a foreign Codex transcript before %s preparation mutates state',
    async (transport) => {
      vi.spyOn(process, 'kill').mockReturnValue(true)
      const directory = mkdtempSync(join(tmpdir(), 'foreign-transcript-'))
      const env = server.buildPtyEnv()
      const send = (body: unknown) =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(body)
        })
      try {
        await send({
          paneKey: PANE,
          agentPid: 101,
          payload: { hook_event_name: 'SessionStart', source: 'startup' }
        })
        expect(server.getLocalAgentPidForPane(PANE)).toBe(101)
        const path = join(directory, 'foreign.jsonl')
        writeFileSync(
          path,
          `${JSON.stringify({
            type: 'event_msg',
            payload: {
              type: 'sub_agent_activity',
              kind: 'started',
              agent_thread_id: 'foreign-child',
              occurred_at_ms: Date.now()
            }
          })}\n`
        )
        const foreign = {
          paneKey: PANE,
          agentPid: 202,
          payload: { hook_event_name: 'PreToolUse', transcript_path: path }
        }
        await (transport === 'http'
          ? send(foreign)
          : (
              server as unknown as { ingestSpoolRecord: (record: SpoolRecord) => Promise<void> }
            ).ingestSpoolRecord({
              ...foreign,
              source: 'codex',
              receivedAt: Date.now(),
              isReplay: false
            }))
        const state = server._getStateForTests()
        expect(state.codexSubagentTranscriptByPaneKey.has(PANE)).toBe(false)
        expect(state.codexSubagentRosterByPaneKey.get(PANE)?.size ?? 0).toBe(0)
        await send({ paneKey: PANE, agentPid: 101, payload: { hook_event_name: 'Stop' } })
        expect(state.lastStatusByPaneKey.get(PANE)?.payload.state).toBe('done')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
  it('ignores helper start, prompt, stop and end without publishing or unbinding the parent', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true)
    const events: unknown[] = []
    server.subscribeEnrichedStatus((event) => events.push(event))
    await post(101, 'parent')
    const state = server._getStateForTests()
    state.claudeNonAgentTasksByPaneKey.set(PANE, 'executing')
    state.claudeActiveSessionCronPaneKeys.add(PANE)
    const previousPrompt = state.lastPromptByPaneKey.get(PANE)
    const count = events.length
    expect(count).toBeGreaterThan(0)
    for (const hook of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
      await post(202, 'helper', hook)
    }
    expect(events).toHaveLength(count)
    expect(state.claudeNonAgentTasksByPaneKey.get(PANE)).toBe('executing')
    expect(state.claudeActiveSessionCronPaneKeys.has(PANE)).toBe(true)
    expect(state.lastPromptByPaneKey.get(PANE)).toBe(previousPrompt)
    await post(101, 'cleared', 'UserPromptSubmit')
    expect(events.at(-1)).toMatchObject({ providerSession: { id: 'cleared' } })
  })

  it('accepts a new process when the parent exited', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('exited'), { code: 'ESRCH' })
    })
    const events: unknown[] = []
    server.subscribeEnrichedStatus((event) => events.push(event))
    await post(101, 'parent')
    await post(202, 'replacement', 'UserPromptSubmit')
    expect(events.at(-1)).toMatchObject({ providerSession: { id: 'replacement' } })
  })

  it('accepts legacy and foreign-host PIDs without local liveness probing', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const events: unknown[] = []
    server.subscribeEnrichedStatus((event) => events.push(event))
    await post(101, 'parent')
    await post(undefined, 'legacy', 'UserPromptSubmit')
    expect(events.at(-1)).toMatchObject({ providerSession: { id: 'legacy' } })
    await post(202, 'wsl', 'UserPromptSubmit', 'remote')
    expect(events.at(-1)).toMatchObject({ providerSession: { id: 'wsl' } })
    expect(kill).not.toHaveBeenCalled()
  })
})
