// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { SessionHostsStatusResult } from '../../../../shared/session-hosts-status'
import { SessionHostSettingsPane } from './SessionHostSettingsPane'

const HOST_ID = 'host_c3ad3c23b1ff43a4b4687a6e9dbb6261'
const state = vi.hoisted(() => ({
  settings: null as unknown,
  status: null as unknown,
  updates: [] as unknown[]
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (s: unknown) => unknown) => selector(state), {
    getState: () => ({
      settings: state.settings,
      updateSettingsOrThrow: async (updates: Partial<GlobalSettings>) => {
        state.updates.push(updates)
        state.settings = { ...(state.settings as object), ...updates }
      }
    })
  })
}))
vi.mock('@/store/session-folders', () => ({
  useSessionFolders: () => ({
    metadata: { folders: [{ id: 'folder-cs', name: 'Customer service' }] }
  })
}))
vi.mock('@/lib/session-hosts-client', () => ({ useSessionHostsStatus: () => state.status }))
vi.mock('../sidebar/use-sidebar-host-scope-options', () => ({
  useSidebarHostScopeOptions: () => ({ hostOptions: [{ id: 'runtime:studio', label: 'Studio' }] })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

afterEach(() => {
  cleanup()
  state.updates = []
})

function renderPane(status: Partial<SessionHostsStatusResult> = {}) {
  const settings = {} as GlobalSettings
  state.settings = settings
  state.status = {
    hosts: [
      {
        hostKey: 'runtime:studio',
        kind: 'runtime',
        state: 'ready',
        hostId: HOST_ID,
        capabilities: [],
        checkedAt: 1,
        counts: null
      }
    ],
    refreshing: false,
    switches: [],
    folderPolicies: {},
    thisHostOffElsewhere: false,
    ...status
  }
  render(<SessionHostSettingsPane settings={settings} />)
}

it('starts with every switch on and no overrides', () => {
  renderPane()
  for (const name of [
    'Let other computers control its sessions',
    'Allow automatic actions on its sessions',
    'Allow moving conversations to or from it',
    'Automatic actions on Studio'
  ]) {
    expect(screen.getByRole('switch', { name }).getAttribute('aria-checked')).toBe('true')
  }
  expect(screen.queryByText('Folders with automatic actions off')).toBeNull()
})

it('switches automatic actions off on another computer, and shows it pending until it confirms', async () => {
  renderPane()
  fireEvent.click(screen.getByRole('switch', { name: 'Automatic actions on Studio' }))
  await waitFor(() =>
    expect(state.updates.at(-1)).toMatchObject({
      sessionHostControl: {
        hostPolicies: { [HOST_ID]: { automation: 'off' } },
        remoteControls: true
      }
    })
  )
  cleanup()
  renderPane({
    switches: [{ hostId: HOST_ID, automation: 'off', at: 5, state: 'pending', setHere: true }]
  })
  expect(
    screen.getByRole('switch', { name: 'Automatic actions on Studio' }).getAttribute('aria-checked')
  ).toBe('false')
  expect(
    screen.getByText('Off, waiting for Studio to confirm (it may be unreachable).')
  ).toBeTruthy()
})

it('lists folders whose automatic actions are off, from any Mac, and turns one back on', async () => {
  renderPane({ folderPolicies: { 'folder-cs': { automation: 'off' } } })
  expect(screen.getByText('Customer service')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Turn back on' }))
  await waitFor(() =>
    expect(state.updates.at(-1)).toMatchObject({
      sessionHostControl: { folderPolicies: { 'folder-cs': {} } }
    })
  )
})
