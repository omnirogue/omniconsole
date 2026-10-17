// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import type { AccountCapacityRow } from '../../../../../../shared/provider-account-capacity'
import { useLauncherAccountRows } from './use-launcher-account-rows'

const watches = vi.hoisted(
  () =>
    new Map<
      string,
      {
        onSnapshot: (snapshot: ProviderAccountsSnapshot) => void
        onError: (error: unknown) => void
      }
    >()
)
vi.mock('@/hooks/useAccountCapacityRows', () => ({
  useAccountCapacityRows: () => [{ choiceId: 'local-account' }]
}))
vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  watchProviderAccounts: (
    settings: { activeRuntimeEnvironmentId: string },
    handlers: typeof watches extends Map<string, infer T> ? T : never
  ) => {
    watches.set(settings.activeRuntimeEnvironmentId, handlers)
    return { close: vi.fn() }
  }
}))
afterEach(() => {
  cleanup()
  watches.clear()
})
const snapshot = (choiceId: string) =>
  ({
    claude: {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    codex: {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    rateLimits: {
      claude: null,
      codex: null,
      gemini: null,
      opencodeGo: null,
      kimi: null,
      antigravity: null,
      minimax: null,
      grok: null,
      minimaxCookieConfigured: false,
      grokAuthConfigured: false,
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: [],
      accountCapacity: { claude: [{ choiceId } as AccountCapacityRow], codex: [], builtAt: 0 }
    }
  }) as ProviderAccountsSnapshot

it('never displays local accounts while waiting for the selected runtime', () => {
  const { result } = renderHook(() => useLauncherAccountRows('worker'))
  expect(result.current.claude).toEqual([])
  act(() => watches.get('worker')!.onSnapshot(snapshot('remote')))
  expect(result.current.claude).toEqual([{ choiceId: 'remote', runtimeEnvironmentId: 'worker' }])
})
it('ignores a late response from the previous computer after switching', () => {
  const { result, rerender } = renderHook(({ owner }) => useLauncherAccountRows(owner), {
    initialProps: { owner: 'one' }
  })
  act(() => watches.get('one')!.onSnapshot(snapshot('one-account')))
  rerender({ owner: 'two' })
  expect(result.current.claude).toEqual([])
  act(() => watches.get('one')!.onSnapshot(snapshot('late-one')))
  expect(result.current.claude).toEqual([])
  act(() => watches.get('two')!.onSnapshot(snapshot('two-account')))
  expect(result.current.claude[0].choiceId).toBe('two-account')
})
