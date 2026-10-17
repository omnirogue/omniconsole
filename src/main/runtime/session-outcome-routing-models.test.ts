import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommitMessageModelCapability } from '../../shared/commit-message-agent-spec'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionPrepRouterCatalog } from '../session-prep/session-prep-router-types'
import {
  discoverSessionOutcomeRoutingModels,
  type OutcomeRoutingAccounts
} from './session-outcome-routing-models'

const { access, accountChoices, accountCatalog } = vi.hoisted(() => ({
  access: vi.fn(),
  accountChoices: vi.fn(),
  accountCatalog: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ access }))
vi.mock('./workflow-script/local-workflow-provider-catalog', () => ({ accountChoices }))
vi.mock('./agent-session-account-model-catalog', () => ({
  discoverAgentSessionAccountCatalog: accountCatalog
}))

const model = (id: string): CommitMessageModelCapability => ({
  id,
  label: id,
  thinkingLevels: ['low', 'medium', 'high'].map((id) => ({ id, label: id }))
})
const source = [model('gpt-6.1-sol'), model('gpt-6-luna'), model('gpt-6-astra')]
const chain = {
  worktreeId: 'workspace',
  workspacePath: '/worker/workspace',
  hostId: 'worker'
} as SessionChain
const choices = [
  { id: 'system:codex', label: 'System', env: { CODEX_HOME: '/accounts/system' } },
  { id: 'profile:codex', label: 'Profile', env: { CODEX_HOME: '/accounts/profile' } }
]
function listing(models = source): SessionPrepRouterCatalog {
  return {
    hostId: 'worker',
    observedAt: 1,
    agents: [{ provider: 'codex', discovered: true, models }]
  }
}
const runtime = (): OutcomeRoutingAccounts => ({
  getAgentAccountSettings: vi.fn(),
  getSessionOutcomeExecutionScope: vi.fn().mockResolvedValue({
    path: chain.workspacePath,
    connectionId: null
  })
})

beforeEach(() => {
  vi.clearAllMocks()
  access.mockResolvedValue(undefined)
  accountChoices.mockReturnValue(choices)
  accountCatalog.mockResolvedValue(listing())
})

describe('workflow model routing account admission', () => {
  it('excludes host models absent from the existing workflow registry', async () => {
    const result = await discoverSessionOutcomeRoutingModels(runtime(), chain, 'codex', source)
    expect(result.models.map((entry) => entry.id)).toEqual(['gpt-6-luna', 'gpt-6-astra'])
    expect(accountCatalog).toHaveBeenCalledTimes(2)
    expect(accountCatalog.mock.calls.map((call) => call[1])).toEqual(
      choices.map((choice) => choice.env)
    )
    expect(accountCatalog.mock.calls[0]?.[0].executionTarget).toEqual({
      path: chain.workspacePath,
      hostId: 'worker'
    })
  })

  it('excludes Luna when any eligible workflow account cannot advertise it', async () => {
    accountCatalog.mockImplementation(async (_request, env) =>
      listing(env.CODEX_HOME === '/accounts/profile' ? [model('gpt-6-astra')] : source)
    )
    const result = await discoverSessionOutcomeRoutingModels(runtime(), chain, 'codex', source)
    expect(result.models.map((entry) => entry.id)).toEqual(['gpt-6-astra'])
  })

  it('requires advertised effort compatibility including the workflow default', async () => {
    accountCatalog.mockImplementation(async (_request, env) =>
      listing(
        env.CODEX_HOME === '/accounts/profile'
          ? source.map((entry) => ({
              ...entry,
              thinkingLevels: [{ id: 'medium', label: 'Medium' }]
            }))
          : source
      )
    )
    const result = await discoverSessionOutcomeRoutingModels(runtime(), chain, 'codex', source)
    expect(result.models).toEqual([])
    expect(result.unavailableReason).toContain('No model is verified')
  })

  it('ignores missing account homes that the workflow catalog also excludes', async () => {
    access.mockImplementation(async (home) => {
      if (home === '/accounts/profile') {
        throw new Error('missing')
      }
    })
    const result = await discoverSessionOutcomeRoutingModels(runtime(), chain, 'codex', source)
    expect(result.models.map((entry) => entry.id)).toEqual(['gpt-6-luna', 'gpt-6-astra'])
    expect(accountCatalog).toHaveBeenCalledTimes(1)
  })

  it('does not use a default/static listing as account availability evidence', async () => {
    accountCatalog.mockResolvedValue({
      ...listing(),
      agents: [{ provider: 'codex', discovered: false, models: source }]
    })
    const result = await discoverSessionOutcomeRoutingModels(runtime(), chain, 'codex', source)
    expect(result.models).toEqual([])
    expect(result.unavailableReason).toContain('incomplete or changed')
  })

  it('requires the actual local workflow execution owner before probing accounts', async () => {
    const owner = runtime()
    vi.mocked(owner.getSessionOutcomeExecutionScope!).mockResolvedValue({
      path: chain.workspacePath,
      connectionId: 'foreign-connection'
    })
    const result = await discoverSessionOutcomeRoutingModels(owner, chain, 'codex', source)
    expect(result.models).toEqual([])
    expect(result.unavailableReason).toContain('execution owner cannot be verified')
    expect(accountCatalog).not.toHaveBeenCalled()
  })

  it('refuses stale evidence when account configuration changes during discovery', async () => {
    accountChoices.mockReturnValueOnce(choices).mockReturnValue([choices[0]])
    const result = await discoverSessionOutcomeRoutingModels(runtime(), chain, 'codex', source)
    expect(result.models).toEqual([])
    expect(result.unavailableReason).toContain('incomplete or changed')
  })

  it('shares in-flight probes and runs no more than two account probes at once', async () => {
    accountChoices.mockReturnValue(
      Array.from({ length: 5 }, (_, index) => ({
        id: `profile:${index}`,
        label: 'Profile',
        env: { CODEX_HOME: `/accounts/${index}` }
      }))
    )
    let active = 0
    let maximum = 0
    const releases: (() => void)[] = []
    accountCatalog.mockImplementation(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      return listing()
    })
    const owner = runtime()
    const first = discoverSessionOutcomeRoutingModels(owner, chain, 'codex', source)
    const second = discoverSessionOutcomeRoutingModels(owner, chain, 'codex', source)
    await vi.waitFor(() => expect(accountCatalog).toHaveBeenCalledTimes(2))
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(accountCatalog).toHaveBeenCalledTimes(4))
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(accountCatalog).toHaveBeenCalledTimes(5))
    releases.splice(0).forEach((release) => release())
    expect((await first).models).toHaveLength(2)
    expect((await second).models).toHaveLength(2)
    expect(maximum).toBe(2)
    expect(active).toBe(0)
  })

  it('retains old defaults when this provider has no exact-account workflow evidence', async () => {
    const result = await discoverSessionOutcomeRoutingModels(runtime(), chain, 'omp', source)
    expect(result.models).toEqual([])
    expect(result.unavailableReason).toContain('account-specific')
    expect(accountCatalog).not.toHaveBeenCalled()
  })
})
