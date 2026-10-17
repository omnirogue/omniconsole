import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionHostSyncEntry } from '../../shared/session-host-sync-doc'
import {
  FOLDER_ONE,
  FOLDER_TWO,
  HOST_AGENT,
  HOST_PERSON,
  hostTestClock,
  openTestHost,
  SYNCED_KEY,
  type OpenedHost
} from './host-organization-test-host'

let dir: string
let clock: ReturnType<typeof hostTestClock>
let opened: OpenedHost

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'host-organization-revoke-'))
  clock = hostTestClock()
  opened = openTestHost(dir, clock)
  await opened.host.migrate({ entries: [], complete: true })
})

afterEach(async () => {
  await opened.host.flush()
  rmSync(dir, { recursive: true, force: true })
})

const move = (folder: string | null, extra: Record<string, unknown> = {}) => ({
  kind: 'move' as const,
  targets: [{ sessionKey: SYNCED_KEY }],
  value: folder,
  executor: HOST_AGENT,
  reason: 'file the review',
  ...extra
})

/** The steward owns the placement; returns its revision and the session's digest. */
async function ownPlacement(): Promise<{ revision: string; digest: string; at: number }> {
  const outcome = await opened.host.apply(move(FOLDER_ONE))
  if (outcome.status !== 'applied') {
    throw new Error(`expected the steward's move to apply: ${JSON.stringify(outcome)}`)
  }
  const [session] = opened.host.read([SYNCED_KEY]).sessions
  expect(session!.ownership.ownership.placement?.revision).toBe(outcome.revision)
  return { revision: outcome.revision, digest: session!.digest!, at: clock.peek() }
}

const placementState = () => opened.host.read([SYNCED_KEY]).sessions[0]!.ownership

async function expectStewardRefused(revision: string): Promise<void> {
  const next = await opened.host.apply(move(FOLDER_TWO, { expectedRevision: revision }))
  expect(next).toMatchObject({ status: 'refused', refusal: { code: 'ownership-conflict' } })
}

describe('a concurrent manual edit takes an agent’s ownership back for good', () => {
  it('local: a person’s change on this host, even to the same folder', async () => {
    const { revision } = await ownPlacement()
    const person = await opened.host.apply(move(FOLDER_ONE, { executor: HOST_PERSON }))
    expect(person.status).toBe('applied')
    expect(placementState()).toEqual({
      ownership: {},
      revocations: { placement: expect.objectContaining({ why: 'person/sidebar' }) }
    })
    await expectStewardRefused(revision)
  })

  it('restored: a restore that puts back another value', async () => {
    const { revision } = await ownPlacement()
    await opened.host.apply(move(FOLDER_TWO, { executor: { kind: 'app', feature: 'restore' } }))
    expect(placementState().revocations.placement?.why).toBe('app/restore')
    await expectStewardRefused(revision)
  })

  it('synced: another computer’s revocation or later change, but never this host’s own echo', async () => {
    const { revision, digest, at } = await ownPlacement()
    const echo: SessionHostSyncEntry = {
      k: 'hist',
      s: digest,
      op: revision,
      ch: 'move',
      by: 'pane',
      at: at + 5_000
    }
    const earlier: SessionHostSyncEntry = {
      ...echo,
      op: 'mac-older',
      by: 'person/sidebar',
      at: at - 60_000
    }
    expect(await opened.host.ingest({ entries: [echo, earlier], headless: true })).toEqual([])
    expect(placementState().ownership.placement?.revision).toBe(revision)

    const later: SessionHostSyncEntry = { ...echo, op: 'mac-later', by: 'cli', at: at + 5_000 }
    expect(await opened.host.ingest({ entries: [later], headless: true })).toEqual([SYNCED_KEY])
    expect(placementState().revocations.placement).toMatchObject({
      opId: 'mac-later',
      why: 'sync/cli'
    })
    await expectStewardRefused(revision)
  })

  it('synced: a person’s revocation on another computer is the person’s here too, owned or not', async () => {
    await ownPlacement()
    const digest = opened.host.read([SYNCED_KEY]).sessions[0]!.digest!
    const revoked: SessionHostSyncEntry = {
      k: 'rev',
      s: digest,
      f: 'title',
      op: 'mac-title',
      why: 'person/sidebar',
      at: clock.peek()
    }
    await opened.host.ingest({ entries: [revoked], headless: true })
    expect(placementState().revocations.title).toMatchObject({ why: 'sync/person/sidebar' })
    expect(placementState().ownership.placement).toBeDefined()
  })

  it('older client: a folder stamp this host did not author, even for the same folder, while headless', async () => {
    const { revision, digest, at } = await ownPlacement()
    const before = new Map([[digest, [FOLDER_TWO, at - 30_000] as [string, number]]])
    expect(await opened.host.ingest({ entries: [], placements: before, headless: true })).toEqual(
      []
    )

    const sameFolder = new Map([[digest, [FOLDER_ONE, at + 1_000] as [string, number]]])
    // With a window, its own sync pass hears stamps (it knows which it authored): not here.
    expect(
      await opened.host.ingest({ entries: [], placements: sameFolder, headless: false })
    ).toEqual([])
    expect(
      await opened.host.ingest({ entries: [], placements: sameFolder, headless: true })
    ).toEqual([SYNCED_KEY])
    expect(placementState().revocations.placement?.why).toBe(`sync/${at + 1_000}`)
    await expectStewardRefused(revision)
  })

  it('older client: the stamp this computer authored for the owned change is its own echo', async () => {
    const { revision, digest, at } = await opened.host
      .apply(move(FOLDER_ONE))
      .then(async (outcome) => ({
        revision: outcome.opId,
        digest: opened.host.read([SYNCED_KEY]).sessions[0]!.digest!,
        at: clock.peek()
      }))
    opened.ledger.store.updateOwnership((states) =>
      states.attachSyncStamps([
        { key: SYNCED_KEY, field: 'placement', opId: revision, stamp: at + 10 }
      ])
    )
    const echo = new Map([[digest, [FOLDER_ONE, at + 10] as [string, number]]])
    expect(await opened.host.ingest({ entries: [], placements: echo, headless: true })).toEqual([])
    const newer = new Map([[digest, [FOLDER_ONE, at + 20] as [string, number]]])
    expect(await opened.host.ingest({ entries: [], placements: newer, headless: true })).toEqual([
      SYNCED_KEY
    ])
  })

  it('a headless change whose field another computer took back is never handed to the window', async () => {
    const { digest, at } = await ownPlacement()
    expect((await opened.host.pendingAdoption()).length).toBe(1)
    await opened.host.ingest({
      entries: [
        { k: 'rev', s: digest, f: 'placement', op: 'mac', why: 'person/sidebar', at: at + 1_000 }
      ],
      headless: true
    })
    expect(await opened.host.pendingAdoption()).toEqual([])
  })
})
