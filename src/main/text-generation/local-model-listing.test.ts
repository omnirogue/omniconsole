import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CommitMessageAgentEnvironmentResolvers,
  CommitMessageAgentRuntimeTarget
} from './commit-message-agent-environment'
import { discoverLocalModelsWithAccount } from './local-model-listing'
import { createModelDiscoveryCache, installLocalModelDiscoveryCache } from './model-discovery-cache'
import {
  _resetQuietBackgroundAgentRunsReaderForTests,
  setQuietBackgroundAgentRunsReader
} from './quiet-background-runs'
import type { DiscoverCommitMessageModelsResult } from './source-control-text-generation-types'

const listing = (id: string): DiscoverCommitMessageModelsResult => ({
  success: true,
  capability: {
    id: 'claude',
    label: 'Claude',
    modelSource: 'dynamic',
    defaultModelId: id,
    models: []
  },
  models: [{ id, label: id }],
  defaultModelId: id,
  catalogOrigin: 'probe'
})

const seat = (dir: string) => ({
  configDir: dir,
  envPatch: { CLAUDE_CONFIG_DIR: dir },
  stripAuthEnv: true,
  provenance: `managed:${dir}`
})

const HOST: CommitMessageAgentRuntimeTarget = { runtime: 'host' }

function opener(
  agentId: string,
  resolvers: CommitMessageAgentEnvironmentResolvers,
  list: (env: NodeJS.ProcessEnv | undefined) => Promise<DiscoverCommitMessageModelsResult>
) {
  return (target = HOST, refresh?: { force?: boolean }) =>
    discoverLocalModelsWithAccount(
      { agentId, agentCommandOverride: undefined, resolvers, target, refresh },
      list
    )
}

beforeEach(() => {
  installLocalModelDiscoveryCache(
    createModelDiscoveryCache({ fingerprint: async (binary) => `/usr/local/bin/${binary}:1:1` })
  )
})

afterEach(() => {
  installLocalModelDiscoveryCache(null)
  _resetQuietBackgroundAgentRunsReaderForTests()
  vi.restoreAllMocks()
})

describe('a local model listing and its account', () => {
  it('sets up a Claude account once for two launcher openings, though the balanced seat moved', async () => {
    const prepareForClaudeLaunch = vi
      .fn()
      .mockResolvedValueOnce(seat('/seats/1'))
      .mockResolvedValue(seat('/seats/2'))
    const listingAccount = vi.fn(() => 'seat-1')
    const list = vi.fn(async () => listing('opus'))
    const open = opener('claude', { prepareForClaudeLaunch, listingAccount }, list)

    await expect(open()).resolves.toEqual(listing('opus'))
    await expect(open()).resolves.toEqual(listing('opus'))
    // No usage refresh, seat choice, keychain read or seat sync for the second opening.
    expect(prepareForClaudeLaunch).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ CLAUDE_CONFIG_DIR: '/seats/1' })
    )
    expect(listingAccount).toHaveBeenCalledWith('claude', HOST)
  })

  it('lists Codex again for another selected account and re-checks a failed listing on a launch', async () => {
    let selected = 'a'
    const prepareForCodexLaunch = vi.fn((): string | null => `/codex/homes/${selected}`)
    const list = vi
      .fn<(env: NodeJS.ProcessEnv | undefined) => Promise<DiscoverCommitMessageModelsResult>>()
      .mockResolvedValueOnce({ success: false, error: 'signed out' })
      .mockResolvedValue(listing('gpt-5.5'))
    const open = opener('codex', { prepareForCodexLaunch, listingAccount: () => selected }, list)

    await expect(open()).resolves.toMatchObject({ success: false })
    await expect(open()).resolves.toMatchObject({ success: false })
    expect(prepareForCodexLaunch).toHaveBeenCalledOnce()
    await expect(open(HOST, { force: true })).resolves.toEqual(listing('gpt-5.5'))
    await expect(open(HOST, { force: true })).resolves.toEqual(listing('gpt-5.5'))
    expect(prepareForCodexLaunch).toHaveBeenCalledTimes(2)
    selected = 'b'
    await open()
    expect(prepareForCodexLaunch).toHaveBeenCalledTimes(3)
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ CODEX_HOME: '/codex/homes/b' }))
  })

  it('never keeps an account that could not be set up', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const prepareForClaudeLaunch = vi
      .fn()
      .mockRejectedValueOnce(new Error('keychain locked'))
      .mockResolvedValue(seat('/seats/1'))
    const list = vi.fn(async () => listing('opus'))
    const open = opener('claude', { prepareForClaudeLaunch, listingAccount: () => 'seat-1' }, list)

    await expect(open()).resolves.toEqual({
      success: false,
      error: 'Failed to prepare the selected agent account for commit message generation.'
    })
    await expect(open()).resolves.toEqual(listing('opus'))
    expect(prepareForClaudeLaunch).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenCalledOnce()
  })

  it('sets the account up every time without a selected-account reader, inside WSL, or with quiet runs off', async () => {
    const prepareForClaudeLaunch = vi.fn().mockResolvedValue(seat('/seats/1'))
    const list = vi.fn(async () => listing('opus'))
    const unkeyed = opener('claude', { prepareForClaudeLaunch }, list)
    await unkeyed()
    await unkeyed()
    expect(prepareForClaudeLaunch).toHaveBeenCalledTimes(2)

    const keyed = opener('claude', { prepareForClaudeLaunch, listingAccount: () => 'seat-1' }, list)
    const wsl: CommitMessageAgentRuntimeTarget = { runtime: 'wsl', wslDistro: 'Ubuntu' }
    await keyed(wsl)
    await keyed(wsl)
    expect(prepareForClaudeLaunch).toHaveBeenCalledTimes(4)

    setQuietBackgroundAgentRunsReader(() => false)
    await keyed()
    await keyed()
    expect(prepareForClaudeLaunch).toHaveBeenCalledTimes(6)
    expect(list).toHaveBeenCalledTimes(6)
  })
})
