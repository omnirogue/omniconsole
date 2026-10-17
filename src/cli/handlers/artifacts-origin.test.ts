import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ARTIFACT_HANDLERS } from './artifacts'

const PANE = 'tab-a:11111111-1111-4111-8111-111111111111'

async function planFolder(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omni-artifact-origin-cli-'))
  await writeFile(join(cwd, 'plan.html'), '<h1>Plan</h1>', 'utf8')
  return cwd
}

function writeCall() {
  return vi.fn().mockImplementation((method: string) =>
    Promise.resolve(
      method === 'settings.get'
        ? { id: 'p', ok: true, result: { settings: {} }, _meta: { runtimeId: 'r' } }
        : {
            id: 'w',
            ok: true,
            result: { status: 'ok', value: { artifact: {}, shareUrl: 'https://x/a/p' } },
            _meta: { runtimeId: 'r' }
          }
    )
  )
}

function stubTerminalEnv(values: Record<string, string>): void {
  for (const name of ['ORCA_TERMINAL_HANDLE', 'ORCA_PANE_KEY', 'ORCA_WORKTREE_ID']) {
    vi.stubEnv(name, values[name] ?? '')
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('artifact CLI session origin', () => {
  it.each(['artifacts share', 'artifacts update'])(
    '`%s` names the IDE terminal it runs in',
    async (command) => {
      stubTerminalEnv({
        ORCA_TERMINAL_HANDLE: 'term-1',
        ORCA_PANE_KEY: PANE,
        ORCA_WORKTREE_ID: 'wt-1'
      })
      const call = writeCall()
      vi.spyOn(console, 'log').mockImplementation(() => undefined)

      await ARTIFACT_HANDLERS[command]!({
        client: { call } as never,
        cwd: await planFolder(),
        flags: new Map([['file', 'plan.html']]),
        json: false
      })

      expect(call).toHaveBeenCalledWith(
        command.replace(' ', '.'),
        expect.objectContaining({
          origin: { terminalHandle: 'term-1', paneKey: PANE, worktreeId: 'wt-1' }
        })
      )
    }
  )

  it('sends no origin from a plain shell', async () => {
    stubTerminalEnv({})
    const call = writeCall()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await ARTIFACT_HANDLERS['artifacts share']!({
      client: { call } as never,
      cwd: await planFolder(),
      flags: new Map([['file', 'plan.html']]),
      json: false
    })

    const params = call.mock.calls.find(([method]) => method === 'artifacts.share')?.[1]
    expect(params).not.toHaveProperty('origin')
  })
})
