/** @vitest-environment happy-dom */
import { beforeEach, expect, it, vi } from 'vitest'
const actions = vi.hoisted(() => ({ openSettingsTarget: vi.fn(), openSettingsPage: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => actions } }))
import {
  openLauncherAccounts,
  rememberLauncherCompany,
  useLauncherTargets
} from './launcher-target'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useLauncherTargets.setState({ companies: {} })
})
it('opens Settings on its accounts pane', () => {
  openLauncherAccounts()
  expect(actions.openSettingsTarget).toHaveBeenCalledWith({ pane: 'accounts', repoId: null })
  expect(actions.openSettingsPage).toHaveBeenCalledOnce()
})
it('rehydrates remembered companies without mixing console scopes', async () => {
  rememberLauncherCompany('scope-a', { name: 'A', slug: 'a' })
  rememberLauncherCompany('scope-b', { name: 'B', slug: 'b' })
  const saved = localStorage.getItem('omni.conversation-launcher-companies.v1')!
  useLauncherTargets.setState({ companies: {} })
  localStorage.setItem('omni.conversation-launcher-companies.v1', saved)
  await useLauncherTargets.persist.rehydrate()
  expect(useLauncherTargets.getState().companies).toEqual({
    'scope-a': { name: 'A', slug: 'a' },
    'scope-b': { name: 'B', slug: 'b' }
  })
})
