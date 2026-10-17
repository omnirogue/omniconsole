import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { discoverExistingAccountDirectories } from '../../../rate-limits/existing-account-directories'
import { IMPORT_EXISTING_ACCOUNTS_METHOD } from './import-existing-accounts'

vi.mock('../../../rate-limits/existing-account-directories', () => ({
  discoverExistingAccountDirectories: vi.fn()
}))

describe('import existing accounts', () => {
  it.each([null, 'saved-default'])(
    'preserves the Codex host default %s after registration selects a new account',
    async (previous) => {
      vi.mocked(discoverExistingAccountDirectories).mockReturnValue([
        { provider: 'codex', path: '/first' },
        { provider: 'codex', path: '/second' }
      ])
      let active: string | null = previous
      const select = vi.fn(async (id: string | null) => {
        active = id
      })
      await IMPORT_EXISTING_ACCOUNTS_METHOD.handler(
        { provider: 'codex', paths: ['/first', '/second'] },
        {
          runtime: {
            getAccountsSnapshot: () => ({ codex: { activeAccountIdsByRuntime: { host: active } } }),
            addCodexAccountFromHome: async (path: string) => {
              active = path
            },
            selectCodexAccountForTarget: select
          } as unknown as OrcaRuntimeService
        }
      )
      expect(active).toBe(previous)
      expect(select).toHaveBeenCalledWith(previous, { runtime: 'host', wslDistro: null })
    }
  )
  it('rejects remote requests before inspecting host profiles', async () => {
    vi.mocked(discoverExistingAccountDirectories).mockClear()
    await expect(
      IMPORT_EXISTING_ACCOUNTS_METHOD.handler(
        { provider: 'claude' },
        {
          runtime: {} as OrcaRuntimeService,
          clientKind: 'runtime'
        }
      )
    ).rejects.toThrow('on the host')
    expect(discoverExistingAccountDirectories).not.toHaveBeenCalled()
  })

  it('requires a reviewed selection and previews without importing', async () => {
    vi.mocked(discoverExistingAccountDirectories).mockReturnValue([
      { provider: 'claude', path: '/first', email: 'me@example.com' }
    ])
    const add = vi.fn()
    const context = {
      runtime: { addClaudeAccountFromConfigDir: add } as unknown as OrcaRuntimeService
    }
    expect(
      await IMPORT_EXISTING_ACCOUNTS_METHOD.handler({ provider: 'claude', preview: true }, context)
    ).toEqual({ directories: [{ provider: 'claude', path: '/first', email: 'me@example.com' }] })
    await expect(
      IMPORT_EXISTING_ACCOUNTS_METHOD.handler({ provider: 'claude' }, context)
    ).rejects.toThrow('Choose')
    await expect(
      IMPORT_EXISTING_ACCOUNTS_METHOD.handler(
        { provider: 'claude', paths: ['/arbitrary'] },
        context
      )
    ).rejects.toThrow('no longer available')
    expect(add).not.toHaveBeenCalled()
  })

  it('keeps importing after duplicate or invalid profiles and does not switch the default', async () => {
    vi.mocked(discoverExistingAccountDirectories).mockReturnValue([
      { provider: 'claude', path: '/first' },
      { provider: 'claude', path: '/alias' },
      { provider: 'claude', path: '/expired' },
      { provider: 'claude', path: '/last' },
      { provider: 'codex', path: '/other-provider' }
    ])
    const add = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('This Claude account is already added.'))
      .mockRejectedValueOnce(new Error('Unavailable credentials'))
      .mockResolvedValueOnce({})
    const select = vi.fn()
    const result = await IMPORT_EXISTING_ACCOUNTS_METHOD.handler(
      { provider: 'claude', paths: ['/first', '/alias', '/expired', '/last'] },
      {
        runtime: {
          addClaudeAccountFromConfigDir: add,
          selectClaudeAccount: select,
          getAccountsSnapshot: () => ({})
        } as unknown as OrcaRuntimeService
      }
    )
    expect(result).toMatchObject({ imported: 2, alreadyAdded: 1, needsAttention: 1 })
    expect(add).toHaveBeenCalledTimes(4)
    expect(select).not.toHaveBeenCalled()
  })
})
