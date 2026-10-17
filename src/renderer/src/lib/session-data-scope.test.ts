// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { sessionDataScopeKey } from './session-data-scope'
vi.mock('@/store', () => ({ useAppStore: vi.fn() }))
const state = {
  activeOrcaProfileId: 'profile',
  orcaProfileAuthStatus: {
    state: 'connected',
    cloud: { userId: 'person', cloudProfileId: 'cloud', activeOrgId: 'team' }
  },
  settings: {
    backofficeEnv: 'production',
    backofficeProductionUrl: 'https://example.com',
    backofficeLocalUrl: 'http://localhost'
  }
} as AppState
it('partitions account, organization, environment, origin and runtime', () => {
  const key = sessionDataScopeKey(state, 'runtime-a')
  expect(sessionDataScopeKey({ ...state }, 'runtime-a')).toBe(key)
  expect(sessionDataScopeKey(state, 'runtime-b')).not.toBe(key)
  expect(sessionDataScopeKey({ ...state, activeOrcaProfileId: 'other' }, 'runtime-a')).not.toBe(key)
  expect(
    sessionDataScopeKey(
      { ...state, settings: { ...state.settings!, backofficeEnv: 'local' } },
      'runtime-a'
    )
  ).not.toBe(key)
  expect(
    sessionDataScopeKey(
      {
        ...state,
        settings: { ...state.settings!, backofficeProductionUrl: 'https://other.example' }
      },
      'runtime-a'
    )
  ).not.toBe(key)
  expect(
    sessionDataScopeKey(
      {
        ...state,
        orcaProfileAuthStatus: {
          ...state.orcaProfileAuthStatus!,
          cloud: { ...state.orcaProfileAuthStatus!.cloud!, activeOrgId: 'other' }
        }
      },
      'runtime-a'
    )
  ).not.toBe(key)
})
