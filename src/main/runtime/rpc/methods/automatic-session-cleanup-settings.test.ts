import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { OrcaRuntimeService } from '../../omni-runtime'
import { SettingsUpdate } from './client-settings-schemas'
import { CLIENT_UI_METHODS } from './client-ui'
import { RpcDispatcher } from '../dispatcher'

const PROTECTION = {
  protectedWorkspacePaths: ['/work/email/'],
  protectedPaneKeys: ['tab:pane'],
  protectStartedToday: true,
  timeZone: 'America/New_York'
}

describe('owner-local cleanup settings RPC', () => {
  it('round trips validated protection and idle settings through the owning runtime', async () => {
    let settings = getDefaultSettings('/tmp')
    const updateSettings = vi.fn((updates) => {
      settings = { ...settings, ...updates }
    })
    const runtime = new OrcaRuntimeService({ getSettings: () => settings, updateSettings } as never)
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
    const response = await dispatcher.dispatch({
      id: 'test',
      authToken: 'tok',
      method: 'settings.update',
      params: {
        automaticSessionCleanupProtection: PROTECTION,
        idleAutoCloseMode: 'shadow',
        idleAutoCloseMinutes: 30
      }
    })
    expect(response.ok).toBe(true)
    expect(updateSettings).toHaveBeenCalledWith(
      {
        automaticSessionCleanupProtection: {
          ...PROTECTION,
          protectedWorkspacePaths: ['/work/email']
        },
        idleAutoCloseMode: 'shadow',
        idleAutoCloseMinutes: 30
      },
      { notifyListeners: true }
    )
    expect(runtime.getClientSettings()).toMatchObject({
      automaticSessionCleanupProtection: settings.automaticSessionCleanupProtection,
      idleAutoCloseMode: 'shadow',
      idleAutoCloseMinutes: 30,
      restoreFloodGuard: true
    })
    await runtime.updateClientSettings({ automaticSessionCleanupProtection: null })
    expect(runtime.getClientSettings().automaticSessionCleanupProtection).toBeNull()
  })

  it.each([
    { automaticSessionCleanupProtection: {} },
    { automaticSessionCleanupProtection: { ...PROTECTION, timeZone: 'bad-zone' } },
    { automaticSessionCleanupProtection: { ...PROTECTION, protectedWorkspacePaths: ['relative'] } },
    { automaticSessionCleanupProtection: { ...PROTECTION, unrecognized: true } },
    { idleAutoCloseMode: 'yes' },
    { idleAutoCloseMinutes: 0 },
    { idleAutoCloseMinutes: 1441 },
    { restoreFloodGuard: false }
  ])('rejects malformed or non-allowlisted update %j', (params) => {
    expect(SettingsUpdate.safeParse(params).success).toBe(false)
  })

  it('keeps older and malformed profiles inert when read over RPC', () => {
    const runtime = new OrcaRuntimeService({
      getSettings: () => ({ automaticSessionCleanupProtection: {} })
    } as never)
    expect(runtime.getClientSettings()).toMatchObject({
      automaticSessionCleanupProtection: null,
      idleAutoCloseMode: 'shadow',
      idleAutoCloseMinutes: 30,
      restoreFloodGuard: false
    })
  })
})
