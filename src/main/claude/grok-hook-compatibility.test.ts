import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/unused-hook-test' } }))
import { getManagedScript } from './hook-service'
import { getGrokManagedScript } from '../grok/grok-hook-script'

describe('Grok importing Claude hooks', () => {
  it.skipIf(process.platform === 'win32')(
    'posts only the native Grok event and preserves ordinary Claude hooks',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'omni-grok-compat-'))
      const captured = join(root, 'requests')
      try {
        writeFileSync(
          join(root, 'curl'),
          '#!/bin/sh\ncat >/dev/null\nprintf "%s\\n" "$*" >> "$CAPTURE"\n',
          { mode: 0o755 }
        )
        const env = {
          PATH: `${root}:/usr/bin:/bin`,
          HOME: root,
          CAPTURE: captured,
          ORCA_PANE_KEY: 'tab:leaf',
          ORCA_AGENT_HOOK_PORT: '9',
          ORCA_AGENT_HOOK_TOKEN: 'fixture',
          GROK_HOOK_EVENT: 'Stop',
          GROK_SESSION_ID: 'grok-session'
        }
        const run = async (name: string, script: string, environment: NodeJS.ProcessEnv) => {
          const path = join(root, name)
          writeFileSync(path, script)
          const result = await runProcess({
            program: '/bin/sh',
            args: [path],
            env: environment,
            timeoutMs: 5000,
            input: JSON.stringify({
              hook_event_name: 'Stop',
              session_id: 'grok-session',
              padding: 'x'.repeat(100000)
            })
          })
          expect(result.code).toBe(0)
          expect(result.timedOut).toBe(false)
          return result
        }
        expect((await run('claude.sh', getManagedScript('posix'), env)).stdout.trim()).toBe('{}')
        expect(existsSync(captured)).toBe(false)
        await run('grok.sh', getGrokManagedScript('posix'), env)
        expect(readFileSync(captured, 'utf8')).toContain('/hook/grok')
        expect(readFileSync(captured, 'utf8')).not.toContain('/hook/claude')
        await run('claude.sh', getManagedScript('posix'), {
          ...env,
          GROK_HOOK_EVENT: '',
          GROK_SESSION_ID: ''
        })
        expect(readFileSync(captured, 'utf8')).toContain('/hook/claude')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
