import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_FOLDERS_NO_WINDOW_ERROR } from '../../shared/session-folder-cli'
import { HOST_ORGANIZATION_NO_REVISION } from '../../shared/session-organization-host'
import { SESSION_ACTIONS_FILE } from '../session-manage/session-actions-log'
import { HOST_ORGANIZATION_NOT_MIGRATED } from './host-organization-commit'
import { HOST_ORGANIZATION_VIEW_FILE } from './host-organization-view'
import {
  ORGANIZATION_HISTORY_DIRECTORY,
  ORGANIZATION_HISTORY_FILE
} from './organization-history-store'
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
const opened: OpenedHost[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'host-organization-'))
  clock = hostTestClock()
})

afterEach(async () => {
  await Promise.all(opened.splice(0).map(({ host }) => host.flush()))
  rmSync(dir, { recursive: true, force: true })
})

function open(extra: Parameters<typeof openTestHost>[2] = {}): OpenedHost {
  const host = openTestHost(dir, clock, extra)
  opened.push(host)
  return host
}

function trail(): Record<string, unknown>[] {
  return readFileSync(join(dir, SESSION_ACTIONS_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const move = (key: string, folder: string | null) => ({
  kind: 'move' as const,
  targets: [{ sessionKey: key }],
  value: folder,
  executor: HOST_AGENT,
  reason: 'group the launch work'
})

describe('headless organization commits', () => {
  it('commits with no window and survives a restart: values, revisions, history, ownership, Undo', async () => {
    const first = open()
    await first.host.migrate({ entries: [], complete: true })
    const moved = await first.host.apply(move('a', FOLDER_ONE))
    expect(moved).toMatchObject({
      status: 'applied',
      mode: 'headless',
      before: [null],
      after: [FOLDER_ONE]
    })
    const archived = await first.host.apply({
      kind: 'archive',
      targets: [{ sessionKey: 'a' }],
      value: true,
      executor: { kind: 'app', feature: 'auto-archive' }
    })
    expect(archived.status).toBe('applied')
    await first.host.flush()
    first.host.dispose()

    const second = open()
    await second.host.ready
    const [session] = second.host.read(['a']).sessions
    expect(session!.values).toMatchObject({ placement: FOLDER_ONE, archived: true })
    expect(session!.revisions).toEqual({
      placement: moved.status === 'applied' ? moved.revision : '',
      archived: archived.status === 'applied' ? archived.revision : ''
    })
    expect(session!.organizationRevision).toBe(archived.status === 'applied' && archived.revision)
    expect(session!.ownership.ownership.placement).toMatchObject({ value: FOLDER_ONE, by: 'pane' })
    const history = await second.host.history('a')
    expect(history.entries.map((entry) => [entry.kind, entry.headless])).toEqual([
      ['archive', true],
      ['move', true]
    ])

    const undo = await second.host.undo(moved.opId, { mintOpId: 'undo-1' })
    expect(undo).toMatchObject({ undone: 1, total: 1, skipped: [] })
    expect(second.host.read(['a']).sessions[0]!.values.placement).toBeNull()
    expect((await second.host.history('a')).entries[0]).toMatchObject({
      opId: 'undo-1',
      undoOf: moved.opId,
      executor: { kind: 'person', via: 'notice' }
    })
  })

  it('rebuilds the values from the trail when the derived files are lost', async () => {
    const first = open()
    await first.host.migrate({ entries: [], complete: true })
    await first.host.apply(move('a', FOLDER_ONE))
    await first.host.flush()
    first.host.dispose()
    const directory = join(dir, ORGANIZATION_HISTORY_DIRECTORY)
    for (const file of [HOST_ORGANIZATION_VIEW_FILE, ORGANIZATION_HISTORY_FILE]) {
      rmSync(join(directory, file), { force: true })
    }
    expect(existsSync(join(directory, HOST_ORGANIZATION_VIEW_FILE))).toBe(false)

    const second = open()
    await second.host.ready
    expect(second.host.read(['a']).sessions[0]!.values.placement).toBe(FOLDER_ONE)
  })

  it('settles a headless change a crash left prepared as failed: nothing half-applied, nothing blocked', async () => {
    const first = open()
    await first.host.migrate({ entries: [], complete: true })
    await first.ledger.prepare(
      { ...move('a', FOLDER_ONE), opId: 'crashed' },
      { before: [null], headless: true }
    )
    await first.ledger.flush()
    first.host.dispose()

    const second = open()
    await second.host.ready
    expect(second.ledger.pending()).toEqual([])
    expect(second.host.read(['a']).sessions[0]?.values.placement ?? null).toBeNull()
    expect(
      trail()
        .filter((line) => line.opId === 'crashed')
        .map((line) => line.phase)
    ).toEqual(['prepared', 'failed'])
    expect((await second.host.apply(move('a', FOLDER_TWO))).status).toBe('applied')
  })

  it("leaves a window's interrupted change pending, and refuses automation on its target until reconciled", async () => {
    const first = open()
    await first.host.migrate({ entries: [], complete: true })
    await first.ledger.prepare({ ...move('a', FOLDER_ONE), opId: 'relayed' }, { before: [null] })
    await first.ledger.flush()
    first.host.dispose()

    const second = open()
    await second.host.ready
    expect(second.ledger.pending().map((record) => record.opId)).toEqual(['relayed'])
    expect(second.host.read(['a']).sessions[0]?.pending ?? ['relayed']).toEqual(['relayed'])
    const refused = await second.host.apply(move('a', FOLDER_TWO))
    expect(refused).toMatchObject({ status: 'refused', refusal: { code: 'reconciling' } })
  })
})

describe('admission', () => {
  it('refuses automation until existing organization is migrated; a person is never held back', async () => {
    const { host } = open()
    const early = await host.apply(move('a', FOLDER_ONE))
    expect(early).toMatchObject({
      status: 'refused',
      refusal: { code: 'not-adopted', message: HOST_ORGANIZATION_NOT_MIGRATED }
    })
    const person = await host.apply({ ...move('b', FOLDER_ONE), executor: HOST_PERSON })
    expect(person).toMatchObject({ status: 'applied', mode: 'headless' })
    await host.migrate({ entries: [], complete: false })
    expect((await host.apply(move('a', FOLDER_ONE))).status).toBe('refused')
    await host.migrate({ entries: [], complete: true })
    expect((await host.apply(move('a', FOLDER_ONE))).status).toBe('applied')
  })

  it('refuses a change made against an older organization revision, naming the current one', async () => {
    const { host } = open()
    await host.migrate({ entries: [], complete: true })
    expect(host.read(['a']).sessions[0]!.organizationRevision).toBe(HOST_ORGANIZATION_NO_REVISION)
    const observed = host.read(['a']).sessions[0]!.organizationRevision
    const person = await host.apply({ ...move('a', FOLDER_TWO), executor: HOST_PERSON })
    const late = await host.apply({
      ...move('a', FOLDER_ONE),
      expectedOrganizationRevision: observed
    })
    expect(late).toMatchObject({
      status: 'refused',
      refusal: {
        code: 'stale-organization-revision',
        current: { organizationRevision: person.opId }
      }
    })
    expect(host.read(['a']).sessions[0]!.values.placement).toBe(FOLDER_TWO)
  })

  it('answers a repeated operation id with its recorded outcome, and refuses it for another change', async () => {
    const { host } = open()
    await host.migrate({ entries: [], complete: true })
    const first = await host.apply({ ...move('a', FOLDER_ONE), opId: 'host-op-1' })
    const again = await host.apply({ ...move('a', FOLDER_ONE), opId: 'host-op-1' })
    expect(again).toMatchObject({ status: 'applied', replay: true, revision: 'host-op-1' })
    expect(first.status === 'applied' && again.status === 'applied' && again.after).toEqual(
      first.status === 'applied' && first.after
    )
    const other = await host.apply({ ...move('a', FOLDER_TWO), opId: 'host-op-1' })
    expect(other).toMatchObject({ status: 'refused', refusal: { code: 'operation-conflict' } })
  })

  it('checks ownership revisions like the window: stale or the person’s refuses; a move needs a reason', async () => {
    const { host } = open()
    await host.migrate({ entries: [], complete: true })
    const owned = await host.apply(move('a', FOLDER_ONE))
    const moved = await host.apply(move('a', FOLDER_TWO))
    const stale = await host.apply({ ...move('a', null), expectedRevision: owned.opId })
    expect(stale).toMatchObject({ status: 'refused', refusal: { code: 'ownership-conflict' } })
    expect(stale.status === 'refused' && stale.refusal.message).toContain(`it is at ${moved.opId}`)
    await host.apply({ ...move('a', FOLDER_ONE), executor: HOST_PERSON })
    const yours = await host.apply({ ...move('a', null), expectedRevision: moved.opId })
    expect(yours.status === 'refused' && yours.refusal.message).toContain("is the person's now")
    const { reason: _reason, ...unreasoned } = move('b', FOLDER_ONE)
    expect(await host.apply(unreasoned)).toMatchObject({
      status: 'refused',
      refusal: { code: 'invalid-request' }
    })
  })
})

describe('with a window', () => {
  it('applies through the window while one is attached, recorded as the window’s change', async () => {
    const relay = vi.fn(async (request: { kind: string; change?: { opId: string } }) => ({
      opId: request.change!.opId,
      targets: [{ sessionKey: 'a' }],
      value: FOLDER_ONE,
      before: [null],
      after: [FOLDER_ONE]
    }))
    const { host } = open({ relay: relay as never, windowAttached: () => true })
    await host.migrate({ entries: [], complete: true })
    const outcome = await host.apply(move('a', FOLDER_ONE))
    expect(outcome).toMatchObject({ status: 'applied', mode: 'window', after: [FOLDER_ONE] })
    expect(relay).toHaveBeenCalledWith(expect.objectContaining({ kind: 'applyOrganizationChange' }))
    expect(host.read(['a']).sessions[0]!.values.placement).toBe(FOLDER_ONE)
    expect(await host.pendingAdoption()).toEqual([])
  })

  it('commits headlessly under the same operation id when the window is gone', async () => {
    const relay = vi.fn(async () => {
      throw new Error(SESSION_FOLDERS_NO_WINDOW_ERROR)
    })
    const { host } = open({ relay: relay as never })
    await host.migrate({ entries: [], complete: true })
    const outcome = await host.apply({ ...move('a', FOLDER_ONE), opId: 'gone-1' })
    expect(outcome).toMatchObject({ status: 'applied', mode: 'headless', opId: 'gone-1' })
    expect(
      trail()
        .filter((line) => line.opId === 'gone-1')
        .map((line) => line.phase)
    ).toEqual(['prepared', 'failed', 'prepared', 'applied'])
    expect((await host.pendingAdoption()).map((record) => record.opId)).toEqual(['gone-1'])
  })
})

describe('outbox', () => {
  it('queues history, ownership and revocations for other computers, under the session digest', async () => {
    const { host, outbox } = open()
    await host.migrate({ entries: [], complete: true })
    const owned = await host.apply(move(SYNCED_KEY, FOLDER_ONE))
    const digest = host.read([SYNCED_KEY]).sessions[0]!.digest!
    expect(digest).toMatch(/^[0-9a-f]{24}$/)
    const entries = () => outbox.pending().map((item) => item.entry as Record<string, unknown>)
    expect(entries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          k: 'hist',
          s: digest,
          op: owned.opId,
          ch: 'move',
          by: 'pane',
          r: owned.opId,
          v: FOLDER_ONE
        }),
        expect.objectContaining({
          k: 'own',
          s: digest,
          f: 'placement',
          r: owned.opId,
          v: FOLDER_ONE
        })
      ])
    )
    await host.apply({ ...move(SYNCED_KEY, FOLDER_TWO), executor: HOST_PERSON })
    expect(entries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ k: 'rev', s: digest, f: 'placement', why: 'person/sidebar' })
      ])
    )
    // A key with no canonical identity (a bare test key) is kept local.
    await host.apply(move('local-only', FOLDER_ONE))
    expect(entries().every((entry) => entry.s !== undefined)).toBe(true)
  })
})
