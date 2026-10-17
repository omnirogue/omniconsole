import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ledgerServiceHarness, memoryPaneStore, PANE } from './ledger-service-fixture'
import type { LedgerResumeSpawn } from './ledger-resume-links'

vi.mock('../agent-hooks/server', () => ({
  agentHookServer: { subscribeEnrichedStatus: () => () => {} }
}))
vi.mock('../git/runner', () => ({ gitExecFileAsync: vi.fn() }))
vi.mock('../backoffice/console-workflow-person', () => ({
  currentConsolePublicationScope: () => ({ principal: 'principal-a' })
}))
vi.mock('../backoffice/console-workflow-transport', () => ({ requestConsoleWorkflow: vi.fn() }))
vi.mock('./ledger-muted-repos', () => ({ readMutedRepos: () => [], setRepoMuted: () => [] }))

const TARGET = 'resumed:22222222-2222-4222-8222-222222222222'
const native = { key: 'session_id' as const, id: 'same-native-conversation' }
const card = { cardId: 'btk_original', cardTitle: 'Keep the filed outcome' }
const spawn: LedgerResumeSpawn = {
  paneKey: TARGET,
  ptyId: 'new-pty',
  worktreeId: 'workspace',
  agent: 'omp',
  connectionId: null,
  providerSession: native
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function fixture(connectionId: string | null = null) {
  const store = memoryPaneStore()
  const h = ledgerServiceHarness({ paneStore: store })
  if (connectionId === null) {
    h.service.stampPaneEnv({
      paneKey: PANE,
      ptyId: 'old-pty',
      worktreeId: 'workspace',
      launchAgent: 'omp'
    })
  }
  h.hook({
    hookEventName: 'SessionStart',
    worktreeId: 'workspace',
    connectionId,
    providerSession: native,
    payload: { agentType: 'omp' }
  })
  await h.service.linkCard(PANE, card)
  return { h, store, original: h.service.resumeLinks.read(PANE)! }
}

describe('task binding on a resumed native conversation', () => {
  it.each([null, 'ssh-owner'])(
    'persists and registers the original task for a new pane on %s',
    async (connectionId) => {
      const { h, store, original } = await fixture(connectionId)
      await h.service.shutdown()
      const resumed = ledgerServiceHarness({ paneStore: store })
      expect(resumed.service.localSessions()).toEqual([])
      expect(await resumed.service.resumeLinks.carry({ ...spawn, connectionId })).toBe(true)
      const link = resumed.service.resumeLinks.read(TARGET)!
      expect(link).toMatchObject(card)
      expect(link.ledgerId).not.toBe(original.ledgerId)
      expect(resumed.registered).toContainEqual([
        link.ledgerId,
        { card_id: card.cardId, card_title: card.cardTitle },
        'principal-a'
      ])
      expect(resumed.service.localSessions()).toEqual([])
      const restarted = ledgerServiceHarness({ paneStore: store })
      expect(restarted.service.resumeLinks.read(TARGET)).toEqual(link)
      expect(restarted.service.localSessions()).toEqual([])
      expect(store.load().find((row) => row.paneKey === TARGET)?.resumeIdentity).toEqual({
        nativeSessionId: native.id,
        nativeSessionKey: native.key,
        agent: 'omp',
        worktreeId: 'workspace',
        connectionId
      })
    }
  )

  it.each(['account', 'agent', 'native', 'key', 'workspace', 'host'])(
    'refuses a different %s',
    async (changed) => {
      const { h } = await fixture()
      if (changed === 'account') {
        h.account.current = 'principal-b'
      }
      const request = {
        ...spawn,
        ...(changed === 'agent' ? { agent: 'claude' } : {}),
        ...(changed === 'workspace' ? { worktreeId: 'other' } : {}),
        ...(changed === 'host' ? { connectionId: 'ssh-owner' } : {}),
        ...(changed === 'native' ? { providerSession: { ...native, id: 'other' } } : {}),
        ...(changed === 'key' ? { providerSession: { ...native, key: 'conversation_id' } } : {})
      }
      expect(await h.service.resumeLinks.carry(request)).toBe(false)
      expect(h.service.resumeLinks.read(TARGET)).toBeNull()
    }
  )

  it('keeps an explicit destination task and rejects an ambiguous source task', async () => {
    const { h } = await fixture()
    h.service.stampPaneEnv({ paneKey: TARGET, ptyId: 'new-pty', worktreeId: 'workspace' })
    await h.service.linkCard(TARGET, { cardId: 'btk_other', cardTitle: 'Explicit' })
    expect(await h.service.resumeLinks.carry(spawn)).toBe(false)
    expect(h.service.resumeLinks.read(TARGET)?.cardId).toBe('btk_other')
    h.hook({
      paneKey: TARGET,
      hookEventName: 'SessionStart',
      worktreeId: 'workspace',
      providerSession: native,
      payload: { agentType: 'omp' }
    })
    expect(
      await h.service.resumeLinks.carry({
        ...spawn,
        paneKey: 'third:33333333-3333-4333-8333-333333333333'
      })
    ).toBe(false)
  })

  it('does not restore a task explicitly removed from a destination', async () => {
    const { h } = await fixture()
    h.service.stampPaneEnv({ paneKey: TARGET, ptyId: 'new-pty', worktreeId: 'workspace' })
    await h.service.linkCard(TARGET, { cardId: null, cardTitle: null })
    expect(await h.service.resumeLinks.carry(spawn)).toBe(false)
    expect(h.service.resumeLinks.read(TARGET)).toBeNull()
  })

  it('does not infer host or native identity from an older disk row', async () => {
    const { store } = await fixture()
    store.save(store.load().map(({ resumeIdentity: _identity, ...row }) => row))
    const h = ledgerServiceHarness({ paneStore: store })
    expect(await h.service.resumeLinks.carry(spawn)).toBe(false)
    expect(h.service.resumeLinks.read(PANE)?.cardId).toBe(card.cardId)
  })

  it('does not expose an earlier account’s saved task', async () => {
    const { h } = await fixture()
    h.account.current = 'principal-b'
    expect(h.service.resumeLinks.read(PANE)).toBeNull()
    h.account.current = null
    expect(h.service.resumeLinks.read(PANE)).toBeNull()
  })

  it('does not turn a remote source into a local source when a later hook omits its connection', async () => {
    const { h } = await fixture('ssh-owner')
    h.hook({ hookEventName: 'Stop', providerSession: native, payload: { agentType: 'omp' } })
    expect(await h.service.resumeLinks.carry(spawn)).toBe(false)
    expect(await h.service.resumeLinks.carry({ ...spawn, connectionId: 'ssh-owner' })).toBe(true)
  })
})
