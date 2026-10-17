import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { SessionHostOwnershipGrant } from './session-host-identity'
import {
  type SessionHostOwnershipGrantSchema,
  isRelocationManifestPath,
  sessionHostRelocationManifestDigest
} from './session-host-payload-schema'
import type { SessionHostOrigin, SessionHostUnattended } from './session-host-authority'
import { SESSION_HOST_ACTIONS, SESSION_HOST_ACTION_SPECS } from './session-host-protocol'
import {
  FIXTURE_MANIFEST,
  FIXTURE_ORIGIN,
  SESSION_HOST_REQUEST_FIXTURES
} from './session-host-request-fixtures'
import {
  SessionHostHistoryParamsSchema,
  SessionHostObserveParamsSchema,
  SessionHostOperationParamsSchema,
  type SessionHostOriginSchema,
  SessionHostReleaseParamsSchema,
  SessionHostRequestSchema,
  SessionHostTidyParamsSchema,
  type SessionHostUnattendedSchema,
  SessionHostWaitStatusParamsSchema,
  parseSessionHostRequest
} from './session-host-schema'
import { FIXTURE_CONVERSATION_ID, fixtureOperationId } from './session-host-wire-fixtures'

const wire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value))
const continueRequest = SESSION_HOST_REQUEST_FIXTURES.continue

describe('session host request schema', () => {
  it('has a fixture for every action, and nothing else', () => {
    expect(Object.keys(SESSION_HOST_REQUEST_FIXTURES).sort()).toEqual(
      [...SESSION_HOST_ACTIONS].sort()
    )
    expect(Object.keys(SESSION_HOST_ACTION_SPECS).sort()).toEqual([...SESSION_HOST_ACTIONS].sort())
  })

  it.each(SESSION_HOST_ACTIONS)('round-trips %s through JSON unchanged', (action) => {
    const fixture = SESSION_HOST_REQUEST_FIXTURES[action]
    const parsed = SessionHostRequestSchema.parse(wire(fixture))
    expect(parsed).toEqual(fixture)
    expect(SessionHostRequestSchema.parse(wire(parsed))).toEqual(parsed)
  })

  it('refuses any field it does not know, at the envelope, origin or payload', () => {
    const cases: unknown[] = [
      { ...continueRequest, authority: { kind: 'person' } },
      { ...continueRequest, payload: { ...continueRequest.payload, actor: { kind: 'steward' } } },
      { ...continueRequest, payload: { ...continueRequest.payload, executor: { kind: 'person' } } },
      { ...continueRequest, origin: { ...FIXTURE_ORIGIN, steward: true } }
    ]
    for (const raw of cases) {
      expect(SessionHostRequestSchema.safeParse(wire(raw)).success).toBe(false)
    }
  })

  it('cannot express a steward, and takes a person only as origin evidence', () => {
    const steward = {
      ...continueRequest,
      origin: { computer: 'Studio', requester: { kind: 'steward' } }
    }
    expect(SessionHostRequestSchema.safeParse(wire(steward)).success).toBe(false)
    const person = {
      ...continueRequest,
      origin: { computer: 'Studio', requester: { kind: 'person', via: 'sidebar' } }
    }
    expect(SessionHostRequestSchema.parse(wire(person)).origin.requester).toEqual({
      kind: 'person',
      via: 'sidebar'
    })
    // A newer client's surface name is audited, never refused as an unknown enum member.
    const newer = {
      ...person,
      origin: { ...person.origin, requester: { kind: 'person', via: 'focus-view' } }
    }
    expect(SessionHostRequestSchema.safeParse(wire(newer)).success).toBe(true)
  })

  it('requires origin evidence on every mutation', () => {
    const { origin: _origin, ...withoutOrigin } = continueRequest
    const result = parseSessionHostRequest(wire(withoutOrigin))
    expect(result).toEqual({ ok: false, message: expect.stringContaining('origin') })
    expect(result.ok ? '' : result.message).toContain('Nothing was changed')
  })

  it('validates the payload against its own action', () => {
    const swapped = { ...continueRequest, action: 'ask' }
    const result = parseSessionHostRequest(wire(swapped))
    expect(result).toEqual({ ok: false, message: expect.stringContaining('payload') })
  })

  it('refuses identities that are not the frozen shapes', () => {
    const bad: Record<string, unknown>[] = [
      { operationId: 'op-1' },
      { operationId: `${fixtureOperationId(1)}0` },
      { conversationId: 'conv_ABC' },
      { conversationId: FIXTURE_CONVERSATION_ID.replace('conv_', 'pane_') },
      { expectedOwnerEpoch: 0 },
      { expectedOwnerEpoch: 1.5 },
      { expectedTurnRevision: 'turn with spaces' },
      { expectedTurnRevision: '' },
      { expectedOrganizationRevision: 'x'.repeat(257) }
    ]
    for (const patch of bad) {
      expect(
        SessionHostRequestSchema.safeParse(wire({ ...continueRequest, ...patch })).success
      ).toBe(false)
    }
  })

  it('keeps relocation manifests inside their bundle', () => {
    for (const path of [
      '../etc/passwd',
      '/abs/file',
      'C:/x',
      'a\\b',
      'a//b',
      'a/./b',
      'a/../b',
      'a/\u0000b',
      ''
    ]) {
      expect(isRelocationManifestPath(path)).toBe(false)
    }
    expect(isRelocationManifestPath('projects/abc/session.jsonl')).toBe(true)
    const stage = SESSION_HOST_REQUEST_FIXTURES['relocate.stage']
    const escaping = {
      ...stage,
      payload: {
        ...stage.payload,
        manifest: { ...FIXTURE_MANIFEST, files: [{ ...FIXTURE_MANIFEST.files[0], path: '../x' }] }
      }
    }
    expect(SessionHostRequestSchema.safeParse(wire(escaping)).success).toBe(false)
  })

  it('digests a manifest independently of file order and changes with any file', () => {
    const files = [
      { path: 'b.jsonl', bytes: 2, sha256: 'b'.repeat(64) },
      { path: 'a.jsonl', bytes: 1, sha256: 'a'.repeat(64) }
    ]
    const body = { version: 1 as const, provider: 'codex' as const, providerSessionId: 's', files }
    const reversed = { ...body, files: files.toReversed() }
    expect(sessionHostRelocationManifestDigest(body)).toBe(
      sessionHostRelocationManifestDigest(reversed)
    )
    const changed = { ...body, files: [{ ...files[0]!, bytes: 3 }, files[1]!] }
    expect(sessionHostRelocationManifestDigest(changed)).not.toBe(
      sessionHostRelocationManifestDigest(body)
    )
    expect(sessionHostRelocationManifestDigest(body)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('requires a target receipt before a source may settle as accepted', () => {
    const settle = SESSION_HOST_REQUEST_FIXTURES['transfer.settle-source']
    const { targetReceipt: _receipt, ...withoutReceipt } = settle.payload
    expect(
      SessionHostRequestSchema.safeParse(wire({ ...settle, payload: withoutReceipt })).success
    ).toBe(false)
    const abandoned = {
      ...settle,
      payload: { transfer: settle.payload.transfer, outcome: 'abandoned' }
    }
    expect(SessionHostRequestSchema.safeParse(wire(abandoned)).success).toBe(true)
  })

  it('keeps the hand-written types and their schemas the same shape', () => {
    expectTypeOf<
      z.infer<typeof SessionHostOwnershipGrantSchema>
    >().toEqualTypeOf<SessionHostOwnershipGrant>()
    expectTypeOf<
      z.infer<typeof SessionHostUnattendedSchema>
    >().toEqualTypeOf<SessionHostUnattended>()
    expectTypeOf<z.infer<typeof SessionHostOriginSchema>>().toEqualTypeOf<SessionHostOrigin>()
  })
})

describe('session host method params', () => {
  const cases = [
    [
      SessionHostObserveParamsSchema,
      { conversationIds: [FIXTURE_CONVERSATION_ID], includeArchived: true }
    ],
    [
      SessionHostOperationParamsSchema,
      { operationId: fixtureOperationId(1), conversationId: FIXTURE_CONVERSATION_ID }
    ],
    [
      SessionHostReleaseParamsSchema,
      {
        operationId: fixtureOperationId(2),
        conversationId: FIXTURE_CONVERSATION_ID,
        reservation: fixtureOperationId(1),
        origin: FIXTURE_ORIGIN
      }
    ],
    [
      SessionHostTidyParamsSchema,
      {
        operationId: fixtureOperationId(3),
        apply: true,
        include: [FIXTURE_CONVERSATION_ID],
        origin: FIXTURE_ORIGIN
      }
    ],
    [SessionHostHistoryParamsSchema, { conversationId: FIXTURE_CONVERSATION_ID, limit: 20 }],
    [
      SessionHostWaitStatusParamsSchema,
      { registration: fixtureOperationId(4), dependency: FIXTURE_CONVERSATION_ID }
    ]
  ] as const

  it.each(cases.map(([schema, value], index) => [index, schema, value] as const))(
    'round-trips params case %i and refuses an unknown key',
    (_index, schema, value) => {
      expect(schema.parse(wire(value))).toEqual(value)
      expect(schema.safeParse(wire({ ...value, extra: 1 })).success).toBe(false)
    }
  )
})
