import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { getManagedScript } from '../claude/claude-managed-hook-script'
import { runProcess } from '../../shared/child-process/run-process'
import { makePaneKey } from '../../shared/stable-pane-id'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const paneKey = makePaneKey('queue-tab', '11111111-1111-4111-8111-111111111111')
describe.skipIf(process.platform === 'win32')('queued SubagentStart delivery', () => {
  it('executes the hook without curl, delivers live status, and drains starts before a synchronous stop', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hook-queue-'))
    dirs.push(directory)
    const server = new AgentHookServer()
    await server.start({ userDataPath: directory, env: 'production' })
    try {
      const fakeCurl = join(directory, 'curl')
      const curlMarker = join(directory, 'curl-called')
      writeFileSync(fakeCurl, `#!/bin/sh\nprintf called > '${curlMarker}'\nsleep 2\n`)
      chmodSync(fakeCurl, 0o755)
      const script = join(directory, 'hook.sh')
      writeFileSync(script, getManagedScript('posix'))
      const env = server.buildPtyEnv()
      const onEvent = vi.fn()
      server.hookEvents.subscribe(onEvent)
      const result = await runProcess({
        program: '/bin/sh',
        args: [script],
        input: JSON.stringify({
          hook_event_name: 'SubagentStart',
          agent_id: 'child',
          agent_type: 'Explore',
          session_id: 'parent'
        }),
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          HOME: directory,
          ...env,
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'queue-tab',
          ORCA_AGENT_LAUNCH_TOKEN: 'synthetic-launch'
        },
        timeoutMs: 1500
      })
      expect(result).toMatchObject({ code: 0, timedOut: false, stdout: '{}\n' })
      expect(() => readFileSync(curlMarker)).toThrow()
      await vi.waitFor(() =>
        expect(server.getStatusSnapshot()[0]?.subagents?.[0]?.id).toBe('child')
      )
      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ isReplay: false }))
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify({
          paneKey,
          tabId: 'queue-tab',
          launchToken: 'synthetic-launch',
          payload: { hook_event_name: 'SubagentStop', agent_id: 'child', session_id: 'parent' }
        })
      })
      expect(response.status).toBe(204)
      expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
    } finally {
      server.stop()
    }
  })
})
