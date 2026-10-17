import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { registerLocalOllamaHandlers } from './local-ollama'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  readContext: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/unused-local-ollama-test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('../local-ollama/ollama-model-context', () => ({
  readOllamaModelContext: mocks.readContext
}))

beforeEach(() => {
  mocks.handlers.clear()
  mocks.readContext.mockReset()
  registerLocalOllamaHandlers(
    () => ({}) as GlobalSettings,
    () => ({}) as GlobalSettings
  )
})

describe('localOllama:prepareLaunch context propagation', () => {
  it.each([131_072, 4096, undefined])(
    'passes the host context %s into the inline config',
    async (context) => {
      mocks.readContext.mockResolvedValue(context)
      const result = (await mocks.handlers.get('localOllama:prepareLaunch')!(null, {
        model: 'gemma4:e2b-mlx',
        templateId: 'default'
      })) as { ok: true; env: { OPENCODE_CONFIG_CONTENT: string } }
      expect(result.ok).toBe(true)
      const config = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT)
      expect(config.provider.ollama.models['gemma4:e2b-mlx'].limit?.context).toBe(context)
      if (context === undefined) {
        expect(config.provider.ollama.models['gemma4:e2b-mlx'].limit).toBeUndefined()
      }
      expect(config.compaction).toEqual({ auto: false })
      expect(mocks.readContext).toHaveBeenCalledWith('gemma4:e2b-mlx', expect.any(String))
    }
  )

  it('does not probe or prepare an invalid model or unknown template', async () => {
    const handler = mocks.handlers.get('localOllama:prepareLaunch')!
    expect(await handler(null, { model: 'not a tag', templateId: 'default' })).toMatchObject({
      ok: false
    })
    expect(await handler(null, { model: 'gemma4:e2b-mlx', templateId: 'unknown' })).toMatchObject({
      ok: false
    })
    expect(mocks.readContext).not.toHaveBeenCalled()
  })
})
