import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionArchiveProjection } from '../../shared/session-archive-projection'
import type { OrganizationChange } from '../../shared/session-organization-change'
import { testHostRoot, type TestHostRoot } from '../session-host/session-host-test-fixture'
import { sidebarRow } from '../session-manage/session-manage-test-fixtures'
import { sessionOrganizationLedgerFor } from '../session-organization/organization-change-ledger'
import { headlessSessionArchives, publishHeadlessSessionArchives } from './headless-session-archive'
import type { HostListedRows } from './host-session-inventory'

const PANE = 'tab-1:leaf-1'
const KEY = 'pane:tab-1:leaf-1'
const LISTED_AT = 1_000_000

describe('where a windowless owner says its sessions sit', () => {
  const listed = (row = sidebarRow()): HostListedRows => ({ rows: [row], listedAt: LISTED_AT })

  it('is where the window last listed them while nothing changed since', () => {
    const archives = headlessSessionArchives(
      {
        rows: [
          sidebarRow({ archived: true, archivedByHand: true }),
          sidebarRow({ paneKey: 'tab-2:leaf-1', viewKey: 'pane:tab-2:leaf-1', archived: true }),
          sidebarRow({ paneKey: 'tab-3:leaf-1', viewKey: 'pane:tab-3:leaf-1' })
        ],
        listedAt: LISTED_AT
      },
      () => ({ archived: false, at: LISTED_AT - 1, byHand: true })
    )

    expect([...archives]).toEqual([
      [PANE, { archived: true, byHand: true }],
      ['tab-2:leaf-1', { archived: true, byHand: false }],
      ['tab-3:leaf-1', { archived: false, byHand: false }]
    ])
  })

  it('follows an archive or unarchive made after that listing, a steward archive not by hand', () => {
    const after = (change: { archived: boolean; byHand: boolean }) =>
      headlessSessionArchives(listed(sidebarRow({ archived: !change.archived })), (key) =>
        key === KEY ? { ...change, at: LISTED_AT + 1 } : undefined
      ).get(PANE)

    expect(after({ archived: true, byHand: true })).toEqual({ archived: true, byHand: true })
    expect(after({ archived: true, byHand: false })).toEqual({ archived: true, byHand: false })
    expect(after({ archived: false, byHand: true })).toEqual({ archived: false, byHand: false })
  })

  it('leaves out a row with no pane, which a paired computer cannot address', () => {
    expect(
      headlessSessionArchives(listed(sidebarRow({ paneKey: null })), () => undefined).size
    ).toBe(0)
  })
})

describe('publishing it from the organization ledger', () => {
  let root: TestHostRoot
  let stop: (() => void) | null = null
  beforeEach(() => {
    root = testHostRoot()
  })
  afterEach(async () => {
    stop?.()
    await sessionOrganizationLedgerFor(root.root).flush()
    root.dispose()
  })

  async function applied(
    kind: 'archive' | 'unarchive',
    opId: string,
    executor: OrganizationChange['executor']
  ) {
    const ledger = sessionOrganizationLedgerFor(root.root)
    const change: OrganizationChange = {
      opId,
      kind,
      targets: [{ sessionKey: KEY }],
      value: kind === 'archive',
      executor,
      reason: 'test'
    }
    // Why: a person's change is recorded once it applied; the app's is prepared first.
    if (executor.kind !== 'person') {
      await ledger.prepare(change, {})
    }
    await ledger.settle({
      phase: 'applied',
      change,
      before: [kind !== 'archive'],
      after: [kind === 'archive']
    })
  }

  it('moves the row on the paired computer after an archive here, and back after an unarchive', async () => {
    let reader: ((paneKey: string) => SessionArchiveProjection | undefined) | null = null
    let republished = 0
    stop = publishHeadlessSessionArchives(
      {
        setHeadlessSessionArchiveReader: (next) => {
          reader = next
        },
        republishHeadlessSessionArchive: () => {
          republished += 1
        }
      },
      { lastListed: () => ({ rows: [sidebarRow()], listedAt: Date.now() - 1_000 }) },
      root.root
    )
    const read = (): SessionArchiveProjection | undefined => reader?.(PANE)
    expect(read()).toEqual({ archived: false, byHand: false })

    await applied('archive', 'op-archive', { kind: 'person', via: 'sidebar' })
    expect(read()).toEqual({ archived: true, byHand: true })
    await applied('unarchive', 'op-unarchive', { kind: 'person', via: 'sidebar' })
    expect(read()).toEqual({ archived: false, byHand: false })
    await applied('archive', 'op-steward', { kind: 'app', feature: 'steward' })
    expect(read()).toEqual({ archived: true, byHand: false })
    expect(republished).toBe(3)

    stop()
    stop = null
    expect(reader).toBeNull()
  })
})
