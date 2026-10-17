import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ settings: {} as Record<string, string> }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings: mocks.settings }) } }))
vi.mock('./http-link-routing', () => ({ openHttpLink: vi.fn() }))
import { openHttpLink } from './http-link-routing'
import { openSessionLedgerConsole } from './session-ledger-console'
afterEach(() => {
  mocks.settings = {}
  vi.clearAllMocks()
})
it('uses the configured console origin and existing external routing', () => {
  mocks.settings = { backofficeEnv: 'local', backofficeLocalUrl: 'http://localhost:4477' }
  openSessionLedgerConsole()
  expect(openHttpLink).toHaveBeenCalledWith('http://localhost:4477/sessions', {
    forceSystemBrowser: true
  })
  openSessionLedgerConsole('peer&other=1')
  expect(openHttpLink).toHaveBeenLastCalledWith(
    'http://localhost:4477/sessions?ledger=peer%26other%3D1',
    { forceSystemBrowser: true }
  )
})
it('does not navigate when the configured origin is invalid', () => {
  mocks.settings = { backofficeProductionUrl: 'bad-url' }
  openSessionLedgerConsole()
  expect(openHttpLink).not.toHaveBeenCalled()
})
