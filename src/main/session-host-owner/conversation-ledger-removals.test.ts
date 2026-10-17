import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  sessionConversationIdentity,
  sessionConversationRemovalKey,
  SESSION_CONVERSATION_LEDGER_LIMITS,
  type RuntimeSessionConversationRemoval
} from '../../shared/session-conversation-ledger'
import type { OrganizationChange } from '../../shared/session-organization-change'
import type { HostOrganizationEntry } from '../../shared/session-organization-host'
import { paneSessionFolderKey } from '../../shared/session-folder-identity'
import {
  HOST_PERSON,
  hostTestClock,
  openTestHost,
  type OpenedHost
} from '../session-organization/host-organization-test-host'
import {
  CONVERSATION_REMOVAL_RETENTION_MS,
  conversationLedgerRemovals,
  conversationRemovalIdentity,
  publishConversationLedgerRemovals
} from './conversation-ledger-removals'
import { LEAF_A, providerKey, WORKTREE } from './main-conversation-inventory-test-fixture'

const PANE_KEY = paneSessionFolderKey(LOCAL_EXECUTION_HOST_ID, WORKTREE, `tab-1:${LEAF_A}`)
const WORKFLOW_KEY = JSON.stringify([LOCAL_EXECUTION_HOST_ID, WORKTREE, 'tab-workflow'])
const DIGEST = sessionConversationIdentity({
  worktreeId: WORKTREE,
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'session-1' }
})

describe('which conversation a deleted key names', () => {
  it('is the digest for a provider key, the pane for a pane key and the anchor tab for a workflow', () => {
    expect(conversationRemovalIdentity(providerKey('session-1'))).toEqual({
      worktreeId: WORKTREE,
      conversation: DIGEST
    })
    expect(conversationRemovalIdentity(PANE_KEY)).toEqual({
      worktreeId: WORKTREE,
      paneIdentity: `pane:tab-1:${LEAF_A}`
    })
    expect(conversationRemovalIdentity(WORKFLOW_KEY)).toEqual({
      worktreeId: WORKTREE,
      workflowTabId: 'tab-workflow'
    })
  })

  it('is nothing for another computer’s row, a structured chat or an unreadable key', () => {
    expect(
      conversationRemovalIdentity(providerKey('x').replace('"local"', '"runtime:env-1"'))
    ).toBe(null)
    expect(conversationRemovalIdentity(JSON.stringify(['local', 'structured', 'chat-1']))).toBe(
      null
    )
    expect(conversationRemovalIdentity(JSON.stringify(['local', 'routine', 'r-1']))).toBe(null)
    expect(conversationRemovalIdentity('pane:tab-1:leaf')).toBe(null)
  })
})

describe('the retained tombstones', () => {
  const NOW = Date.UTC(2026, 9, 6, 12)
  const values = (entries: Record<string, HostOrganizationEntry>) => ({
    keys: () => Object.keys(entries),
    entry: (key: string) => entries[key]
  })
  const deletedAt = (at: number, deleted = true): HostOrganizationEntry => ({
    values: { deleted },
    revisions: { deleted: 'op' },
    stamps: { deleted: new Date(at).toISOString() }
  })

  it('keeps the last 90 days, newest first, hands older ones over as aged, and drops an undone or unstamped delete', () => {
    const read = conversationLedgerRemovals(
      values({
        [providerKey('old')]: deletedAt(NOW - CONVERSATION_REMOVAL_RETENTION_MS - 1),
        [providerKey('kept')]: deletedAt(NOW - 1_000),
        [PANE_KEY]: deletedAt(NOW - 10),
        [providerKey('undone')]: deletedAt(NOW - 5, false),
        [providerKey('unstamped')]: { values: { deleted: true }, revisions: {} }
      }),
      NOW
    )
    expect(read.truncated).toBe(false)
    expect(read.removals.map((removal) => removal.at)).toEqual([NOW - 10, NOW - 1_000])
    // The store shows an aged one only once a listed record held it back and let it go again.
    expect(read.aged.map((removal) => removal.at)).toEqual([
      NOW - CONVERSATION_REMOVAL_RETENTION_MS - 1
    ])
  })

  it('cuts at the contract cap keeping the newest, and says it cut', () => {
    const max = SESSION_CONVERSATION_LEDGER_LIMITS.removals
    const entries: Record<string, HostOrganizationEntry> = {}
    for (let index = 0; index <= max; index += 1) {
      entries[providerKey(`session-${index}`)] = deletedAt(NOW - (max - index) * 1_000)
    }
    const read = conversationLedgerRemovals(values(entries), NOW)
    expect(read.truncated).toBe(true)
    expect(read.removals).toHaveLength(max)
    expect(read.removals[0]!.at).toBe(NOW)
    // The oldest (session-0) is the one cut.
    expect(read.removals.some((removal) => removal.at === NOW - max * 1_000)).toBe(false)
  })
})

describe('publishing them from the host values', () => {
  let dir: string
  let opened: OpenedHost
  let stop: (() => void) | null = null
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conversation-ledger-removals-'))
    opened = openTestHost(dir, hostTestClock(Date.now()))
  })
  afterEach(async () => {
    stop?.()
    await opened.host.flush()
    rmSync(dir, { recursive: true, force: true })
  })

  async function windowDeletes(opId: string, key: string, deleted: boolean) {
    const change: OrganizationChange = {
      opId,
      kind: 'delete',
      targets: [{ sessionKey: key }],
      value: deleted,
      executor: HOST_PERSON
    }
    await opened.ledger.settle({ phase: 'applied', change, before: [!deleted], after: [deleted] })
  }

  it('sends a delete with its identity, a pane and a workflow delete too, and drops an undone one', async () => {
    const setRemovals = vi.fn(
      (_removals: RuntimeSessionConversationRemoval[], _truncated: boolean) => true
    )
    const latest = () => {
      const [removals = [], truncated = false] = setRemovals.mock.lastCall ?? []
      return { removals, truncated }
    }
    stop = publishConversationLedgerRemovals({ setRemovals }, opened.view)
    expect(latest()).toEqual({ removals: [], truncated: false })

    await windowDeletes('del-provider', providerKey('session-1'), true)
    await windowDeletes('del-pane', PANE_KEY, true)
    await windowDeletes('del-workflow', WORKFLOW_KEY, true)
    await vi.waitFor(() => expect(latest().removals).toHaveLength(3))
    const keys = latest().removals.map(sessionConversationRemovalKey)
    expect(keys).toEqual(
      expect.arrayContaining([
        JSON.stringify([`c:${DIGEST}`, WORKTREE]),
        JSON.stringify([`p:pane:tab-1:${LEAF_A}`, WORKTREE]),
        JSON.stringify(['w:tab-workflow', WORKTREE])
      ])
    )
    for (const removal of latest().removals) {
      expect(removal.at).toBe(
        Date.parse(
          opened.view.entry(
            removal.conversation
              ? providerKey('session-1')
              : removal.paneIdentity
                ? PANE_KEY
                : WORKFLOW_KEY
          )!.stamps!.deleted!
        )
      )
    }

    await windowDeletes('undo-provider', providerKey('session-1'), false)
    await vi.waitFor(() => expect(latest().removals).toHaveLength(2))
    expect(latest().removals.some((removal) => removal.conversation === DIGEST)).toBe(false)
  })

  // It runs inline in app startup and in a microtask: a throw there aborts startup or crashes main.
  it('keeps the last list and logs, never throws, when reading the values fails', () => {
    const setRemovals = vi.fn(() => true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      stop = publishConversationLedgerRemovals(
        { setRemovals },
        {
          keys: () => {
            throw new Error('damaged values')
          },
          entry: () => undefined,
          onChange: () => () => {}
        }
      )
      expect(setRemovals).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        '[session-host] reading the conversation ledger tombstones failed',
        expect.objectContaining({ message: 'damaged values' })
      )
    } finally {
      warn.mockRestore()
    }
  })
})
