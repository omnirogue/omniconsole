// Why: Astra's crash window — the typed handoff is saved at once, but the real prompt queue saves
// on a debounce. A restart that finds the handoff without its queue entry must offer the answer
// again (never hold it as unverifiable), and one whose entry did reach disk must leave it typed.
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import { createStore, testState } from '../persistence-test-harness'
import {
  queueEntryState,
  workDeliveryQueueId,
  type WorkDeliveryDeps,
  type WorkPane
} from '../work-delivery/work-delivery-claimer-types'
import type { ClaimableDelivery } from '../work-delivery/work-delivery-kind'
import { AnswerInbox } from './answer-inbox'
import { HOOK_FIRST_WORKING_WAIT_MS, type HookFirstSnapshot } from './hook-first-route'
import { HookFirstRouter } from './hook-first-router'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const PANE: WorkPane = {
  paneKey: 'tab-1:leaf-1',
  worktreeId: 'wt',
  tabId: 'tab-1',
  archived: false,
  title: 'x'
}
const SOURCE = { kind: 'pty' as const, worktreeId: PANE.worktreeId, paneKey: PANE.paneKey }
const ROW = conversationSourceRowKey(SOURCE)
const TARGET = { ref: 'claude:conv-1@local', transcript: 'present' as const }
const DELIVERY = { key: 'review:plan:d1', kind: 'review', context: {} } as ClaimableDelivery
const ID = workDeliveryQueueId(DELIVERY.key)
const TEXT = '[OmniOS decision] Approved: revision 2 of "Plan"\nDo now: carry on.'

/** The work-delivery deps the router wraps, backed by the real profile store's prompt queue. */
function storeDeps(store: ReturnType<typeof createStore>): WorkDeliveryDeps {
  return {
    adapters: new Map(),
    api: { receipt: vi.fn(async () => ({ status: 'ok' as const, value: {} })) },
    enqueue: async (_pane, _target, id, text) => {
      store.enqueuePromptQueueEntry(SOURCE, { id, text, createdAt: Date.now(), state: 'queued' })
      return true
    },
    queueState: (_pane, id) =>
      queueEntryState(store.readPromptQueue(ROW)?.entries.find((entry) => entry.id === id)),
    busy: async () => true,
    findHolder: async () => ({ kind: 'live' as const, pane: PANE }),
    audit: () => {}
  } as unknown as WorkDeliveryDeps
}

function router(clock: { now: number }, saved: HookFirstSnapshot[]) {
  let created: HookFirstRouter | null = null
  const inbox = new AnswerInbox({
    now: () => clock.now,
    onChange: (i) => created?.noteItemChange(i)
  })
  created = new HookFirstRouter({
    inbox,
    enabled: () => true,
    now: () => clock.now,
    onChange: (urgent) => urgent && saved.push(structuredClone(created!.snapshot())),
    holderIdentity: async (pane) => ({
      paneKey: pane.paneKey,
      launchHash: createHash('sha256').update('launch-1').digest('hex'),
      agentPid: null
    })
  })
  return created
}

describe('hook-first typed handoff against the real prompt-queue persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'omni-answer-store-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  async function typedThenCrash(flushQueue: boolean) {
    const clock = { now: Date.parse('2026-10-17T21:00:00Z') }
    const saved: HookFirstSnapshot[] = []
    const store = createStore()
    const first = router(clock, saved)
    const deps = first.wrap(storeDeps(store))
    await deps.findHolder(TARGET)
    expect(await deps.enqueue(PANE, TARGET, ID, TEXT, DELIVERY)).toBe(true)
    clock.now += HOOK_FIRST_WORKING_WAIT_MS
    await first.tick()
    expect(store.readPromptQueue(ROW)?.entries.map((entry) => entry.id)).toEqual([ID])
    expect(saved.at(-1)!.routes[0]).toMatchObject({ id: ID, phase: 'fallback' })
    if (flushQueue) {
      store.flush()
    }
    store.freezeWrites()
    // the app dies here; the next start reads both files from disk
    const reloaded = createStore()
    const restarted = router(clock, [])
    restarted.restore(structuredClone(saved.at(-1)!))
    return { reloaded, deps: restarted.wrap(storeDeps(reloaded)) }
  }

  it('the queue entry never reached disk: the answer is offered again, not held unverifiable', async () => {
    const { reloaded, deps } = await typedThenCrash(false)
    expect(reloaded.readPromptQueue(ROW)).toBeNull()
    expect(deps.queueState(PANE, ID)).toBe('failed-unsent')
  })

  it('the queue entry reached disk: the typed copy owns it and nothing is offered again', async () => {
    const { reloaded, deps } = await typedThenCrash(true)
    expect(reloaded.readPromptQueue(ROW)?.entries.map((entry) => entry.id)).toEqual([ID])
    expect(deps.queueState(PANE, ID)).toBe('queued')
  })
})
