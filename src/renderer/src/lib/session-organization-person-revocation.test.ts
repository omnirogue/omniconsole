import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionOrganizationOwnership } from '@/store/session-organization-ownership'
import type {
  OrganizationChange,
  OrganizationExecutor,
  OrganizationRecord
} from '../../../shared/session-organization-change'
import {
  emptyOrganizationKeyState,
  organizationKeyStatesAfter
} from '../../../shared/session-organization-ownership'
import { applyOrganizationChange } from './session-organization-change'
import { installSessionOrganizationOwnership } from './session-organization-ownership'
import { moveSessionsByPerson } from './session-organization-person-changes'
import {
  CHECKOUT,
  createOrganizationTestStores,
  fakeOrganizationRpc,
  SALES,
  type OrganizationRpcCall
} from './session-organization-test-fixture'
import type { OrganizationTitleStore } from './session-organization-title'
import { renameSessionByPerson } from './session-title-change'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ setTabCustomTitle: vi.fn() }) } }))

const PANE: OrganizationExecutor = { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Ads review' }

/** An agent's applied change the mirror already holds: it owns `field` of session `a`. */
function agentOwned(kind: 'move' | 'title', value: unknown, before: unknown): OrganizationRecord {
  return {
    opId: `agent-${kind}`,
    kind,
    targets: [{ sessionKey: 'a', ...(kind === 'title' ? { tabId: 'tab-a' } : {}) }],
    value,
    executor: PANE,
    reason: 'tidy',
    phase: 'applied',
    ts: '2026-09-25T10:00:00.000Z',
    revision: `agent-${kind}`,
    before: [before],
    after: [value]
  }
}

function setup() {
  const tabs: Record<string, string | null> = { 'tab-a': 'Agent title' }
  const titles: OrganizationTitleStore = {
    read: (tabId) => (tabId in tabs ? { known: true, title: tabs[tabId]! } : { known: false }),
    write: (tabId, title) => {
      tabs[tabId] = title
    }
  }
  const stores = { ...createOrganizationTestStores({ membership: { a: CHECKOUT } }), titles }
  const { rpc, calls } = fakeOrganizationRpc()
  // Why no onApplied: the installed mirror must hear the rerouted person path on its own.
  return { stores, tabs, calls, deps: { stores, rpc } }
}

/** What main's copy does with the record the window settled (the same shared rule). */
function mainStateAfter(call: OrganizationRpcCall) {
  const { change, before, after } = call.params as {
    change: OrganizationChange
    before?: unknown[]
    after?: unknown[]
  }
  const record: OrganizationRecord = {
    ...change,
    phase: 'applied',
    ts: '2026-09-25T10:05:00.000Z',
    ...(before ? { before } : {}),
    ...(after ? { after } : {})
  }
  return organizationKeyStatesAfter(record, () => ({
    ...emptyOrganizationKeyState(),
    ownership: {
      placement: { value: CHECKOUT, revision: 'agent-move', by: 'pane', opId: 'x', at: 'x' }
    }
  })).get('a')
}

const settled = async () => new Promise((resolve) => setTimeout(resolve, 0))

let uninstall: () => void

beforeEach(() => {
  useSessionOrganizationOwnership.setState({ keys: {}, scope: null })
  uninstall = installSessionOrganizationOwnership()
  const mirror = useSessionOrganizationOwnership.getState()
  mirror.applyRecord(agentOwned('move', CHECKOUT, SALES))
  mirror.applyRecord(agentOwned('title', 'Agent title', null))
})

afterEach(() => {
  uninstall()
  useSessionOrganizationOwnership.setState({ keys: {}, scope: null })
})

describe('a person’s rerouted sidebar change takes ownership back for good', () => {
  it('a drop into a folder revokes the placement in the mirror and in main’s record', async () => {
    const { stores, calls, deps } = setup()
    expect(useSessionOrganizationOwnership.getState().ownedField('a', 'placement')).toMatchObject({
      revision: 'agent-move'
    })
    expect(moveSessionsByPerson(['a'], SALES, { deps })).toBe(true)
    expect(stores.folders.getState().metadata.membership.a).toBe(SALES)
    const state = useSessionOrganizationOwnership.getState().stateFor('a')
    expect(state.ownership.placement).toBeUndefined()
    expect(state.revocations.placement).toMatchObject({ why: 'person/sidebar' })
    await settled()
    const settle = calls.find((call) => call.method === 'sessionOrganization.settle')!
    expect(mainStateAfter(settle)?.revocations.placement).toMatchObject({ why: 'person/sidebar' })

    // Permanent: the agent's old revision is refused, and a later agent move owns nothing.
    const agentMove = {
      kind: 'move' as const,
      targets: [{ sessionKey: 'a' }],
      value: CHECKOUT,
      executor: PANE,
      reason: 'tidy',
      expectedRevision: 'agent-move'
    }
    await expect(applyOrganizationChange(agentMove, deps)).resolves.toMatchObject({
      status: 'refused',
      error: expect.stringContaining("is the person's now (person/sidebar)")
    })
    expect(stores.folders.getState().metadata.membership.a).toBe(SALES)
    useSessionOrganizationOwnership.getState().applyRecord({
      ...agentOwned('move', CHECKOUT, SALES),
      opId: 'later',
      revision: 'later'
    })
    expect(useSessionOrganizationOwnership.getState().ownedField('a', 'placement')).toBeNull()
  })

  it('a rename from the row revokes the title the agent chose', () => {
    const { tabs, deps } = setup()
    const outcome = renameSessionByPerson(
      {
        tabId: 'tab-a',
        title: 'My name for it',
        via: 'sidebar',
        target: { sessionKey: 'a', tabId: 'tab-a' }
      },
      deps
    )
    expect(outcome.status).toBe('applied')
    expect(tabs['tab-a']).toBe('My name for it')
    const state = useSessionOrganizationOwnership.getState().stateFor('a')
    expect(state.ownership.title).toBeUndefined()
    expect(state.revocations.title).toMatchObject({ why: 'person/sidebar' })
    // Only the title: the placement the agent chose is still its own.
    expect(state.ownership.placement).toMatchObject({ revision: 'agent-move' })
  })
})
