import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return { ...actual, homedir: homedirMock }
})

import { QWEN_CODE_EVENTS, QwenCodeHookService } from './hook-service'

type Settings = {
  hooks?: Record<string, { matcher?: string; hooks?: { command: string; timeout?: number }[] }[]>
  [key: string]: unknown
}

const USER_HOOK = { type: 'command', command: '/usr/local/bin/my-audit.sh' }

describe('QwenCodeHookService', () => {
  let homeDir: string
  let configPath: string

  const readSettings = (): Settings => JSON.parse(readFileSync(configPath, 'utf8')) as Settings
  const managedCount = (settings: Settings, event: string): number =>
    (settings.hooks?.[event] ?? [])
      .flatMap((definition) => definition.hooks ?? [])
      .filter((hook) => hook.command.includes('qwen-code-hook')).length

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'omni-qwen-home-'))
    configPath = join(homeDir, '.qwen', 'settings.json')
    homedirMock.mockReturnValue(homeDir)
    getPathMock.mockImplementation(() => join(homeDir, 'userData'))
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('installs every managed event into ~/.qwen/settings.json with a millisecond timeout', () => {
    const service = new QwenCodeHookService()
    expect(service.getStatus().state).toBe('not_installed')
    expect(service.install().state).toBe('installed')

    const settings = readSettings()
    for (const event of QWEN_CODE_EVENTS) {
      expect(managedCount(settings, event.eventName), event.eventName).toBe(1)
    }
    expect(settings.hooks?.PermissionRequest?.[0]?.matcher).toBe('*')
    expect(settings.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.timeout).toBe(10_000)
    const script = join(
      homeDir,
      '.omni',
      'agent-hooks',
      process.platform === 'win32' ? 'qwen-code-hook.cmd' : 'qwen-code-hook.sh'
    )
    expect(readFileSync(script, 'utf8')).toContain('/hook/qwen-code')
  })

  it('preserves the user settings and hooks, and is idempotent', () => {
    mkdirSync(join(homeDir, '.qwen'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({
        model: { name: 'qwen3-coder-plus' },
        general: { vimMode: true },
        hooks: { PreToolUse: [{ matcher: 'run_shell_command', hooks: [USER_HOOK] }] }
      })
    )
    const service = new QwenCodeHookService()
    service.install()
    const once = readFileSync(configPath, 'utf8')
    expect(service.install().state).toBe('installed')
    expect(readFileSync(configPath, 'utf8')).toBe(once)

    const settings = readSettings()
    expect(settings.model).toEqual({ name: 'qwen3-coder-plus' })
    expect(settings.general).toEqual({ vimMode: true })
    expect(settings.hooks?.PreToolUse?.[0]).toEqual({
      matcher: 'run_shell_command',
      hooks: [USER_HOOK]
    })
    expect(managedCount(settings, 'PreToolUse')).toBe(1)
  })

  it('removes only its own hooks and keeps everything else', () => {
    mkdirSync(join(homeDir, '.qwen'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({
        model: { name: 'qwen3-coder-plus' },
        hooks: { Stop: [{ hooks: [USER_HOOK] }] }
      })
    )
    const service = new QwenCodeHookService()
    service.install()
    expect(service.remove().state).toBe('not_installed')

    const settings = readSettings()
    expect(settings.model).toEqual({ name: 'qwen3-coder-plus' })
    expect(settings.hooks).toEqual({ Stop: [{ hooks: [USER_HOOK] }] })
    expect(service.remove().state).toBe('not_installed')
  })

  it('keeps a user’s empty hook arrays through install and remove', () => {
    mkdirSync(join(homeDir, '.qwen'), { recursive: true })
    writeFileSync(configPath, JSON.stringify({ hooks: { disabled: [], Notification: [] } }))
    const service = new QwenCodeHookService()
    service.install()
    expect(readSettings().hooks?.disabled).toEqual([])
    expect(readSettings().hooks?.Notification).toEqual([])
    service.remove()
    expect(readSettings().hooks).toEqual({ disabled: [], Notification: [] })
  })

  it('reports partial when a managed event was deleted', () => {
    const service = new QwenCodeHookService()
    service.install()
    const settings = readSettings()
    delete settings.hooks?.PermissionRequest
    writeFileSync(configPath, JSON.stringify(settings))
    expect(service.getStatus()).toMatchObject({
      state: 'partial',
      detail: 'Managed hook missing for events: PermissionRequest'
    })
  })

  it('refuses to touch an unparseable settings file', () => {
    mkdirSync(join(homeDir, '.qwen'), { recursive: true })
    writeFileSync(configPath, '{"hooks": ')
    const service = new QwenCodeHookService()
    expect(service.install().state).toBe('error')
    expect(readFileSync(configPath, 'utf8')).toBe('{"hooks": ')
    expect(existsSync(join(homeDir, '.omni', 'agent-hooks', 'qwen-code-hook.sh'))).toBe(false)
  })
})
