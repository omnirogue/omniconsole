/**
 * One valid `sessionHost.execute` request per action. The mapped type makes a new action without a
 * fixture a compile error, so every action's schema is exercised by the round-trip tests.
 */

import { sessionHostRelocationManifestDigest } from './session-host-payload-schema'
import type { SessionHostOrigin } from './session-host-authority'
import type { SessionHostAction, SessionHostRequest } from './session-host-protocol'
import {
  FIXTURE_CONVERSATION_ID,
  FIXTURE_HOST,
  FIXTURE_NOW,
  FIXTURE_OTHER_CONVERSATION_ID,
  FIXTURE_OTHER_HOST_ID,
  fixtureOperationId
} from './session-host-wire-fixtures'

export const FIXTURE_ORIGIN: SessionHostOrigin = {
  computer: 'Studio',
  requester: { kind: 'pane', paneKey: 'tab-1:leaf-1', title: 'Release notes' },
  request: 'continue the release notes on the build box'
}

const FILES = [{ path: 'projects/abc/session.jsonl', bytes: 1024, sha256: 'a'.repeat(64) }]
const MANIFEST_BODY = {
  version: 1 as const,
  provider: 'claude' as const,
  providerSessionId: 'sess-1',
  files: FILES
}
export const FIXTURE_MANIFEST = {
  ...MANIFEST_BODY,
  digest: sessionHostRelocationManifestDigest(MANIFEST_BODY)
}
const relocation = { relocation: fixtureOperationId(90), provider: 'claude' as const }

type Fixtures = { [A in SessionHostAction]: SessionHostRequest<A> }

function request<A extends SessionHostAction>(
  n: number,
  action: A,
  payload: SessionHostRequest<A>['payload'],
  extra: Partial<SessionHostRequest<A>> = {}
): SessionHostRequest<A> {
  return {
    operationId: fixtureOperationId(n),
    conversationId: FIXTURE_CONVERSATION_ID,
    expectedOwnerEpoch: 1,
    expectedTurnRevision: 'turn:7f3a',
    origin: FIXTURE_ORIGIN,
    action,
    payload,
    ...extra
  } as SessionHostRequest<A>
}

export const SESSION_HOST_REQUEST_FIXTURES: Fixtures = {
  continue: request(1, 'continue', { answer: { kind: 'prompt', text: 'Carry on with step 2.' } }),
  ask: request(2, 'ask', { question: 'What is left?', timeoutMs: 60_000 }),
  answer: request(3, 'answer', { expect: 'b'.repeat(64), answer: { kind: 'choose', choice: 2 } }),
  stop: request(4, 'stop', { force: false }, { expectedTurnRevision: null }),
  restart: request(5, 'restart', {}),
  rename: request(
    6,
    'rename',
    { title: 'Release notes v2', origin: 'yours' },
    { expectedOrganizationRevision: 'org:12' }
  ),
  archive: request(7, 'archive', {}, { expectedOrganizationRevision: 'org:12' }),
  unarchive: request(8, 'unarchive', {}, { expectedOrganizationRevision: 'org:13' }),
  organize: request(
    9,
    'organize',
    { kind: 'move', value: 'saved-sessions' },
    { expectedOrganizationRevision: 'org:12' }
  ),
  undo: request(10, 'undo', { undoOf: 'op-1234' }, { expectedOrganizationRevision: 'org:14' }),
  'transfer.prepare-source': request(11, 'transfer.prepare-source', {
    transfer: fixtureOperationId(80),
    mode: 'consolidate',
    target: { hostId: FIXTURE_OTHER_HOST_ID },
    note: 'Fold into the release session.'
  }),
  'transfer.settle-source': request(
    12,
    'transfer.settle-source',
    {
      transfer: fixtureOperationId(80),
      outcome: 'accepted',
      targetReceipt: {
        hostId: FIXTURE_OTHER_HOST_ID,
        conversationId: FIXTURE_OTHER_CONVERSATION_ID,
        operationId: fixtureOperationId(81)
      }
    },
    { reservation: fixtureOperationId(11) }
  ),
  'relocate.prepare-destination': request(
    13,
    'relocate.prepare-destination',
    {
      ...relocation,
      providerVersion: '2.1.4',
      source: {
        hostId: FIXTURE_OTHER_HOST_ID,
        conversationId: FIXTURE_CONVERSATION_ID,
        ownerEpoch: 1
      },
      workspace: { kind: 'git', commit: 'c'.repeat(40) }
    },
    { expectedOwnerEpoch: 2, expectedTurnRevision: null }
  ),
  'relocate.freeze-source': request(14, 'relocate.freeze-source', {
    ...relocation,
    destination: { hostId: FIXTURE_OTHER_HOST_ID }
  }),
  'relocate.export': request(15, 'relocate.export', relocation, {
    reservation: fixtureOperationId(14)
  }),
  'relocate.stage': request(
    16,
    'relocate.stage',
    { ...relocation, manifest: FIXTURE_MANIFEST },
    { expectedOwnerEpoch: 2, expectedTurnRevision: null }
  ),
  'relocate.relinquish': request(
    17,
    'relocate.relinquish',
    {
      ...relocation,
      destination: { hostId: FIXTURE_OTHER_HOST_ID },
      manifestDigest: FIXTURE_MANIFEST.digest
    },
    { reservation: fixtureOperationId(14) }
  ),
  'relocate.resume': request(
    18,
    'relocate.resume',
    {
      ...relocation,
      grant: {
        grantId: fixtureOperationId(17),
        relocation: relocation.relocation,
        conversationId: FIXTURE_CONVERSATION_ID,
        fromHostId: FIXTURE_OTHER_HOST_ID,
        toHostId: FIXTURE_HOST.hostId,
        ownerEpoch: 2,
        provider: { agent: 'claude', sessionId: 'sess-1' },
        manifestDigest: FIXTURE_MANIFEST.digest,
        issuedAt: FIXTURE_NOW
      }
    },
    { expectedOwnerEpoch: 2, expectedTurnRevision: null }
  ),
  'wait.register': request(
    19,
    'wait.register',
    {
      waiter: { hostId: FIXTURE_OTHER_HOST_ID, conversationId: FIXTURE_OTHER_CONVERSATION_ID },
      match: 'result'
    },
    { expectedTurnRevision: null }
  ),
  'wait.cancel': request(
    20,
    'wait.cancel',
    { registration: fixtureOperationId(19) },
    { expectedTurnRevision: null }
  ),
  deliver: request(21, 'deliver', { text: 'Run the tests.', writer: 'prompt-queue' })
}
