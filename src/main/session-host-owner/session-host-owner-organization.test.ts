import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionHostOrigin } from '../../shared/session-host-authority'
import { fixtureOperationId } from '../../shared/session-host-wire-fixtures'
import {
  adoptTestConversation,
  MAC_B,
  remote,
  testHostRoot,
  type TestHostRoot
} from '../session-host/session-host-test-fixture'
import { setStewardPolicyHooks } from '../session-manage/session-manage-unattended-admission'
import {
  HOST_SESSION_ID,
  HOST_SOURCE,
  ownerTestHost,
  type OwnerTestHost
} from './session-host-owner-test-host'
import { tidyArchiveOperationId } from './session-host-owner-tidy'
import { sessionHostTurnRevision } from './session-host-turn'

let root: TestHostRoot
let host: OwnerTestHost
let restoreHooks: () => void

const STEWARD_ON_STUDIO: SessionHostOrigin = {
  computer: 'Studio',
  requester: { kind: 'cli', unattended: { source: 'rules' } }
}
const TURN = sessionHostTurnRevision({
  known: true,
  turnKey: 't1',
  text: 'Done.',
  complete: true,
  proposal: null,
  empty: false
})

beforeEach(() => {
  root = testHostRoot()
  host = ownerTestHost({ root: root.root })
  restoreHooks = setStewardPolicyHooks({
    tier2Eligibility: async () => ({ ok: true, evidence: 'finished, 6 h quiet' })
  })
})
afterEach(async () => {
  restoreHooks()
  await host.inventory.flush()
  root.dispose()
})

async function adopted() {
  const service = await host.process.service()
  const { conversationId } = await adoptTestConversation(service, HOST_SESSION_ID)
  await service.store.mutate(async (journal) => {
    journal.conversations[conversationId]!.binding = HOST_SOURCE
    return { value: null, changed: true }
  })
  return { service, conversationId }
}

const archive = (n: number, conversationId: string) => ({
  operationId: fixtureOperationId(n),
  conversationId,
  expectedOwnerEpoch: 1,
  expectedTurnRevision: TURN,
  expectedOrganizationRevision: 'org:0',
  action: 'archive' as const,
  payload: {}
})

const waitRegister = (n: number, conversationId: string) => ({
  operationId: fixtureOperationId(n),
  conversationId,
  expectedOwnerEpoch: 1,
  expectedTurnRevision: null,
  action: 'wait.register' as const,
  payload: {
    waiter: { hostId: `host_${'a'.repeat(32)}`, conversationId: `conv_${'b'.repeat(32)}` },
    match: 'result' as const
  }
})

describe('a wait on this conversation keeps it from automatic archive', () => {
  it('registered from another computer, it blocks the steward; cancelled, Tier 2 decides again', async () => {
    const { service, conversationId } = await adopted()
    const registered = await service.execute(
      waitRegister(1, conversationId),
      remote('mac-b', MAC_B)
    )
    expect(registered).toMatchObject({
      operation: { state: 'completed', result: { receipt: { state: 'registered' } } }
    })
    const blocked = await service.execute(
      archive(2, conversationId),
      remote('mac-a', STEWARD_ON_STUDIO)
    )
    expect(blocked).toMatchObject({
      operation: { state: 'refused', refusal: { code: 'not-eligible' } }
    })
    expect(host.organization.applied).toHaveLength(0)
    await service.execute(
      {
        ...waitRegister(3, conversationId),
        action: 'wait.cancel',
        payload: { registration: fixtureOperationId(1) }
      },
      remote('mac-b', MAC_B)
    )
    const archived = await service.execute(
      archive(4, conversationId),
      remote('mac-a', STEWARD_ON_STUDIO)
    )
    expect(archived).toMatchObject({ operation: { state: 'completed' } })
    expect(host.organization.applied[0]).toMatchObject({
      kind: 'archive',
      value: true,
      executor: { kind: 'app', feature: 'steward' },
      evidence: 'finished, 6 h quiet'
    })
  })

  it('an uncertain registration (admitted, never settled) blocks it too', async () => {
    const { service, conversationId } = await adopted()
    await service.store.mutate(async (journal) => {
      const operationId = fixtureOperationId(10)
      journal.operations[operationId] = {
        operationId,
        conversationId,
        action: 'wait.register',
        state: 'unconfirmed',
        fingerprint: 'sha256:uncertain',
        host: service.identity,
        ownerEpoch: 1,
        turnRevision: null,
        kind: 'execute',
        holder: 'remote:mac-b',
        controller: service.identity.incarnation,
        audit: { authority: 'remote', peer: 'mac-b' }
      }
      return { value: null, changed: true }
    })
    const blocked = await service.execute(
      archive(5, conversationId),
      remote('mac-a', STEWARD_ON_STUDIO)
    )
    expect(blocked).toMatchObject({ operation: { refusal: { code: 'not-eligible' } } })
  })

  it('reports a wait satisfied only by the conversation’s own result, and a deadline as unmet', async () => {
    const { service, conversationId } = await adopted()
    await service.execute(waitRegister(6, conversationId), remote('mac-b', MAC_B))
    const status = { registration: fixtureOperationId(6), dependency: conversationId }
    expect(await host.executor.waitStatus(status)).toMatchObject({
      receipt: { state: 'registered' }
    })
    host.waitResult.current = { ownerEpoch: 1, outcomeRevision: 'result:abc', at: 9 }
    expect(await host.executor.waitStatus(status)).toMatchObject({
      receipt: {
        state: 'satisfied',
        satisfiedBy: { ownerEpoch: 1, outcomeRevision: 'result:abc', at: 9 }
      }
    })
  })
})

describe('organization commits against the revision the caller read', () => {
  it('renames as the other computer’s person, and refuses a change made against an older revision', async () => {
    const { service, conversationId } = await adopted()
    const rename = (n: number, expected: string) => ({
      operationId: fixtureOperationId(n),
      conversationId,
      expectedOwnerEpoch: 1,
      expectedTurnRevision: null,
      expectedOrganizationRevision: expected,
      action: 'rename' as const,
      payload: { title: 'Parser: nested quotes' }
    })
    const first = await service.execute(rename(7, 'org:0'), remote('mac-b', MAC_B))
    expect(first).toMatchObject({ operation: { state: 'completed' } })
    expect(host.organization.applied[0]).toMatchObject({
      kind: 'title',
      value: 'Parser: nested quotes',
      executor: { kind: 'person', via: 'sidebar' }
    })
    const stale = await service.execute(rename(8, 'org:0'), remote('mac-b', MAC_B))
    expect(stale).toMatchObject({
      operation: {
        state: 'refused',
        refusal: { code: 'stale-organization-revision', current: { organizationRevision: 'org:1' } }
      }
    })
  })
})

describe('host tidy', () => {
  it('archives each eligible session as its own operation, and a retried tidy archives nothing twice', async () => {
    const { conversationId } = await adopted()
    const params = { operationId: fixtureOperationId(9), apply: true, origin: MAC_B }
    const first = await host.executor.tidy(params, remote('mac-b', MAC_B))
    expect(first).toMatchObject({
      status: 'ok',
      dryRun: false,
      rows: [
        {
          conversationId,
          action: 'archive',
          outcome: 'archived',
          operationId: tidyArchiveOperationId(params.operationId, conversationId)
        }
      ]
    })
    const again = await host.executor.tidy(params, remote('mac-b', MAC_B))
    expect(again).toMatchObject({ rows: [{ outcome: 'archived' }] })
    expect(host.organization.applied).toHaveLength(1)
  })
})
