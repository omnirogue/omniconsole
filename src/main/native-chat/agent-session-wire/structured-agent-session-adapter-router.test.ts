// Which adapter owns a structured session, and why.
//
// The router is the only place the three lanes are ranked, so a mistake here is
// silent: a Claude launch routed to the wrong lane still opens a chat, just one
// driven by a provider the record does not describe. Every case below names the
// lane it expects rather than asserting "something was called".

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

type ManagedAdapter = StructuredAgentSessionAdapter & { closeAll(): Promise<void> }

function lane(name: string, supportsLocation = true) {
  const acquire = vi.fn(async () => ({
    process: { hostId: 'local', pid: 1, processStartTimeMs: 1, spawnToken: 't' },
    link: {
      linkId: name,
      handle: { provider: 'claude' as const, sessionId: 's', leafUuid: null },
      origin: 'created' as const,
      mintedAtFence: 1,
      observedAt: 1
    }
  }))
  const dispatch = vi.fn(async () => ({ state: 'unknown' as const, reason: name }))
  const adapter = {
    supportsLocation: () => supportsLocation,
    supportsCreate: () => supportsLocation,
    acquire,
    dispatch,
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: vi.fn(async () => {}),
    setOption: vi.fn(async () => {}),
    closeSession: vi.fn(async () => true),
    closeAll: vi.fn(async () => {})
  } as unknown as ManagedAdapter
  return { name, adapter, acquire, dispatch }
}

const LOCATION = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'w',
  workspaceKind: 'git-worktree'
} as unknown as Parameters<NonNullable<StructuredAgentSessionAdapter['supportsCreate']>>[0]

function routerWith(
  options: {
    claude?: ReturnType<typeof lane>
    acpEnabled?: (agent: string) => boolean
    claudeEnabled?: () => boolean
    record?: (sessionId: string) => AgentSessionRecord | null
  } = {}
) {
  const codex = lane('codex')
  const acp = lane('acp')
  const claude = options.claude ?? lane('claude')
  const router = new StructuredAgentSessionAdapterRouter({
    codex: codex.adapter,
    acp: acp.adapter,
    claude: claude.adapter,
    claudeEnabled: options.claudeEnabled ?? (() => true),
    acpEnabled: options.acpEnabled ?? (() => false),
    record: options.record ?? (() => null)
  })
  return { router, codex, acp, claude }
}

async function ownerOf(
  router: StructuredAgentSessionAdapterRouter,
  agent: string,
  transport?: 'acp'
): Promise<string> {
  await router.acquire({
    identity: {
      sessionId: `${agent}-1`,
      workspaceId: 'w',
      hostId: 'local',
      agent,
      providerHandle: null
    } as never,
    fence: 1,
    spawnToken: 't',
    ...(transport ? { options: { transport } } : {})
  })
  const outcome = await router.dispatch({
    sessionId: `${agent}-1`,
    clientMessageId: 'c',
    body: { kind: 'message', role: 'user', blocks: [] },
    fence: 1
  })
  return outcome.state === 'unknown' ? outcome.reason : 'unexpected'
}

describe('structured agent-session adapter router', () => {
  it('sends a Claude launch to the agent SDK lane once it is registered and enabled', async () => {
    const { router } = routerWith()
    expect(router.supportsCreate(LOCATION, 'claude')).toBe(true)
    await expect(ownerOf(router, 'claude')).resolves.toBe('claude')
  })

  it('leaves Codex on the app-server lane', async () => {
    const { router } = routerWith()
    await expect(ownerOf(router, 'codex')).resolves.toBe('codex')
  })

  it('honours an explicit ACP transport even for Claude', async () => {
    const { router } = routerWith()
    await expect(ownerOf(router, 'claude', 'acp')).resolves.toBe('acp')
  })

  it('yields Claude to ACP when the person opted that agent into ACP', async () => {
    const { router } = routerWith({ acpEnabled: (agent) => agent === 'claude' })
    await expect(ownerOf(router, 'claude')).resolves.toBe('acp')
    // And the create probe must agree, or the launcher asks a lane the host refuses.
    expect(router.supportsCreate(LOCATION, 'claude')).toBe(true)
  })

  it('fails closed to the pre-existing lane when the SDK lane is disabled', async () => {
    const { router } = routerWith({ claudeEnabled: () => false })
    // Not "throws": the experiment being off must degrade to the old behaviour,
    // which for a Claude launch with ACP also off is a refusal to create at all.
    expect(router.supportsCreate(LOCATION, 'claude')).toBe(false)
    await expect(ownerOf(router, 'claude')).resolves.toBe('acp')
  })

  it('refuses a location the SDK lane cannot supervise instead of falling through to ACP', () => {
    const { router } = routerWith({ claude: lane('claude', false) })
    expect(router.supportsCreate(LOCATION, 'claude')).toBe(false)
  })

  it('routes a recovered session by its record, not by whoever acquired last', async () => {
    const records: Record<string, { provider: string; options?: { transport?: string } }> = {
      'restored-claude': { provider: 'claude' },
      'restored-codex': { provider: 'codex' },
      'restored-acp': { provider: 'claude', options: { transport: 'acp' } }
    }
    const { router } = routerWith({
      record: (id) => (records[id] ?? null) as AgentSessionRecord | null
    })
    const dispatchFor = async (id: string) => {
      const outcome = await router.dispatch({
        sessionId: id,
        clientMessageId: 'c',
        body: { kind: 'message', role: 'user', blocks: [] },
        fence: 1
      })
      return outcome.state === 'unknown' ? outcome.reason : 'unexpected'
    }
    await expect(dispatchFor('restored-claude')).resolves.toBe('claude')
    await expect(dispatchFor('restored-codex')).resolves.toBe('codex')
    await expect(dispatchFor('restored-acp')).resolves.toBe('acp')
    // An unknown session is not a Codex session; guessing Codex would drive the
    // wrong provider rather than refusing.
    await expect(dispatchFor('never-seen')).resolves.toBe('acp')
  })

  it('closes every registered lane, including the SDK one', async () => {
    const { router, codex, acp, claude } = routerWith()
    await router.closeAll()
    expect(codex.adapter.closeAll).toHaveBeenCalledOnce()
    expect(acp.adapter.closeAll).toHaveBeenCalledOnce()
    expect(claude.adapter.closeAll).toHaveBeenCalledOnce()
  })

  it('still works with no Claude lane registered at all', async () => {
    const codex = lane('codex')
    const acp = lane('acp')
    const router = new StructuredAgentSessionAdapterRouter({
      codex: codex.adapter,
      acp: acp.adapter,
      acpEnabled: () => false,
      record: () => null
    })
    expect(router.supportsCreate(LOCATION, 'claude')).toBe(false)
    await expect(ownerOf(router, 'claude')).resolves.toBe('acp')
    await expect(router.closeAll()).resolves.toBeUndefined()
  })
})
