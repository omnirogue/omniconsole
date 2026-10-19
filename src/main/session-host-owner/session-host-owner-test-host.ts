/**
 * A paired host for owner-service tests: the real account registry and admission (package A) in a
 * temporary directory, the real executor and session-manage controls, and fakes only where the
 * runtime would be: its sidebar rows, the panes it observes, the prompt queue and its drain (which
 * sends through the real send door), and the organization host.
 */

import { join } from 'node:path'
import type { ConversationSource } from '../../shared/conversation-source'
import type { PromptQueueEntry, PromptQueueEnqueueInput } from '../../shared/prompt-queue-types'
import type {
  HostOrganizationApi,
  HostOrganizationOutcome,
  HostOrganizationRead
} from '../../shared/session-organization-host'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type {
  OrganizationChange,
  OrganizationHistory
} from '../../shared/session-organization-change'
import { deliverUnderSessionHostAdmission } from '../session-host/session-host-delivery-admission'
import type { SessionHostProcess } from '../session-host/session-host-process'
import { testHostProcess } from '../session-host/session-host-test-fixture'
import type { SessionDeliveryDeps } from '../session-manage/session-manage-deliver'
import type { SessionLatestTurn } from '../session-manage/session-manage-freeform'
import {
  observeSession,
  type SessionObserveSources
} from '../session-manage/session-manage-observe'
import { observeSources, sidebarRow } from '../session-manage/session-manage-test-fixtures'
import { HostSessionInventory } from './host-session-inventory'
import { HostWaitRegistry, type HostWaitResultReader } from './host-wait-registry'
import { hasUncertainWaitRegistration } from './session-host-owner-waits'
import { SessionHostOwnerExecutor } from './session-host-owner-executor'

export const HOST_SESSION_ID = 'claude-session-1'
export const HOST_SOURCE: ConversationSource = {
  worktreeId: 'repo::/w',
  paneKey: 'tab-1:leaf-1',
  kind: 'pty'
}

export function hostRow(overrides: Partial<SessionManageSidebarRow> = {}): SessionManageSidebarRow {
  return sidebarRow({ providerSessionId: HOST_SESSION_ID, ...overrides })
}

export function finishedTurn(turnKey: string): SessionLatestTurn {
  return { known: true, turnKey, text: 'Done.', complete: true, proposal: null, empty: false }
}

/** An in-memory organization host with one revision per session key. */
export class FakeOrganizationHost implements HostOrganizationApi {
  readonly ready = Promise.resolve()
  readonly revisions = new Map<string, number>()
  readonly applied: (Omit<OrganizationChange, 'opId'> & { opId?: string })[] = []

  read(keys?: readonly string[]): HostOrganizationRead {
    return {
      migratedAt: 'now',
      sessions: (keys ?? []).map((key) => ({
        key,
        values: {
          placement: null,
          archived: false,
          title: null,
          tags: [],
          hidden: false,
          snooze: null,
          deleted: false
        },
        revisions: {},
        organizationRevision: `org:${this.revisions.get(key) ?? 0}`,
        ownership: { ownership: {}, revocations: {} },
        pending: []
      }))
    }
  }

  async apply(
    request: Parameters<HostOrganizationApi['apply']>[0]
  ): Promise<HostOrganizationOutcome> {
    const key = request.targets[0]!.sessionKey!
    const current = `org:${this.revisions.get(key) ?? 0}`
    const opId = request.opId ?? 'op'
    if (request.expectedOrganizationRevision && request.expectedOrganizationRevision !== current) {
      return {
        status: 'refused',
        opId,
        refusal: { code: 'stale-organization-revision', message: 'Changed since.' }
      }
    }
    const next = (this.revisions.get(key) ?? 0) + 1
    this.revisions.set(key, next)
    this.applied.push(request)
    return {
      status: 'applied',
      opId,
      mode: 'headless',
      before: [null],
      after: [request.value],
      revision: `rev:${next}`,
      organizationRevisions: [`org:${next}`]
    }
  }

  async history(key: string): Promise<OrganizationHistory> {
    return { key, entries: [], pending: [], ownership: {}, revocations: {} }
  }

  async undo(opId: string) {
    return { opId, undone: 0, total: 0, skipped: [] }
  }

  async migrate() {
    return { imported: 0, drifted: [], personOwned: [], migratedAt: 'now' }
  }
}

export type OwnerTestHost = {
  process: SessionHostProcess
  inventory: HostSessionInventory
  executor: SessionHostOwnerExecutor
  rows: SessionManageSidebarRow[]
  queue: Map<string, PromptQueueEntry & { source: ConversationSource }>
  window: { attached: boolean }
  turn: { current: SessionLatestTurn }
  organization: FakeOrganizationHost
  waits: HostWaitRegistry
  keepGoing: { on: boolean }
  sources: { current: SessionObserveSources }
  waitResult: { current: ReturnType<HostWaitResultReader> }
  /** The queue's drain: sends every queued entry through the real send door. */
  drain(): Promise<void>
}

export function ownerTestHost(input: {
  root: string
  incarnation?: string
  dead?: readonly string[]
}): OwnerTestHost {
  const rows = [hostRow()]
  const window = { attached: true }
  const queue: OwnerTestHost['queue'] = new Map()
  const turn = { current: finishedTurn('t1') }
  const keepGoing = { on: false }
  const sources = { current: observeSources() }
  const organization = new FakeOrganizationHost()
  const waitResult: OwnerTestHost['waitResult'] = { current: null }
  const waits = new HostWaitRegistry(join(input.root, 'waits.json'))
  const inventory = new HostSessionInventory({
    readWindowRows: async () => {
      if (!window.attached) {
        throw new Error('No window is attached.')
      }
      return rows
    },
    observe: (row) => observeSession(row, sources.current),
    cacheFile: join(input.root, 'rows.json')
  })
  let ids = 0
  const delivery: SessionDeliveryDeps = {
    enqueue: (source: ConversationSource, entry: PromptQueueEnqueueInput) => {
      queue.set(entry.id, { ...entry, source, state: 'queued', createdAt: 1 })
    },
    admission: () => null,
    bind: () => () => {},
    readLatestTurn: async () => turn.current,
    snapshotLatestTurn: () => turn.current,
    providerSessionId: (source) =>
      rows.find((row) => row.paneKey === source.paneKey)?.providerSessionId ?? null,
    hasUnresolvedDraft: () => false,
    decideRelayed: async () => {
      throw new Error('not used')
    },
    stopKeepGoing: () => false,
    keepGoingOn: () => keepGoing.on,
    readOwnSteps: async () => ({ set: null, steps: [] }),
    newId: () => `id-${++ids}`
  }
  let process: SessionHostProcess
  const executor = new SessionHostOwnerExecutor({
    inventory,
    readLatestTurn: async () => turn.current,
    delivery: {
      delivery,
      readEntry: (_source, entryId) => queue.get(entryId) ?? null,
      withdrawIfQueued: (_source, entryId, reason) => {
        const entry = queue.get(entryId)
        if (entry?.state !== 'queued') {
          return false
        }
        queue.set(entryId, { ...entry, state: 'failed', reason, unsent: true })
        return true
      },
      askWait: () => {
        throw new Error('not used')
      },
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
      },
      now: () => Date.now()
    },
    controls: {
      control: {
        interrupt: async () => {},
        stopKeepGoing: () => false,
        lastOutputAt: async () => null,
        stillWorking: async () => false,
        resume: async () => ({ summary: 'Resumed.', tabId: 'tab-2' }),
        confirmRestarted: async () => ({ state: 'unconfirmed' as const }),
        keepCheckpoint: async () => false,
        rename: async () => {
          throw new Error('not used')
        },
        sleep: async () => {},
        now: () => Date.now()
      },
      answer: () => {
        throw new Error('not used')
      },
      answerQuarantine: { has: () => false, add: () => {}, delete: () => {} }
    },
    organization: {
      host: () => organization,
      remotelyAwaited: (conversationId) =>
        waits.awaited(conversationId) ||
        hasUncertainWaitRegistration(process.current()?.store.snapshot() ?? null, conversationId)
    },
    tidy: { service: () => process.current(), holdFor: () => null },
    waits,
    readWaitResult: () => waitResult.current,
    actionHandlers: [],
    reconciled: () => true
  })
  process = testHostProcess({
    root: input.root,
    incarnation: input.incarnation ?? 'runtime-1',
    executor,
    ...(input.dead ? { dead: input.dead } : {})
  })
  const drain = async (): Promise<void> => {
    for (const [id, entry] of queue) {
      if (entry.state !== 'queued') {
        continue
      }
      const hostOperation = entry.requestedBy?.hostOperation
      queue.set(id, { ...entry, state: 'sending', operationId: `${Date.now()}-${'e'.repeat(32)}` })
      try {
        const delivered = await deliverUnderSessionHostAdmission({
          host: process,
          source: entry.source,
          text: entry.text,
          operationId: `${Date.now()}-${'f'.repeat(32)}`,
          ...(hostOperation ? { admission: { hostOperation } } : {}),
          deliver: async () => ({ door: 'pty', deliveredAt: 5 })
        })
        queue.set(id, { ...queue.get(id)!, state: 'delivered', deliveredAt: delivered.deliveredAt })
      } catch (error) {
        queue.set(id, {
          ...queue.get(id)!,
          state: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          unsent: true
        })
      }
    }
  }
  return {
    process,
    inventory,
    executor,
    rows,
    queue,
    window,
    turn,
    organization,
    waits,
    keepGoing,
    sources,
    waitResult,
    drain
  }
}
