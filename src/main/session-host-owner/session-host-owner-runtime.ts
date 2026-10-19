import { runtimeHeadlessSessionSleep } from './headless-session-sleep-runtime'
/**
 * Starts the owner service on this paired runtime: installs the executor (so this host advertises
 * control), keeps the account registry in step with its sessions, and holds admission closed until
 * what a previous process left in flight is reconciled. Works with no window: the inventory falls
 * back to the rows the window last listed, and a restart resumes through R2's own launcher.
 */

import { join } from 'node:path'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import { answerWaitKeeper } from '../answer-delivery/answer-wait'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { runtimeSessionAnswerDeps } from '../runtime/rpc/methods/session-manage-answer-runtime'
import { runtimeSessionHostProcess } from '../session-host/session-host-runtime'
import { PersistentSessionAnswerQuarantine } from '../session-manage/session-answer-quarantine'
import { observeSession } from '../session-manage/session-manage-observe'
import {
  readSidebarRows,
  runtimeAskWaitDeps,
  runtimeControlDeps,
  runtimeDeliveryDeps,
  showSessionManageNotice
} from '../session-manage/session-manage-runtime-actions'
import {
  createRuntimeObserveSources,
  readRuntimeLatestTurn,
  runtimeNeverReplied
} from '../session-manage/session-manage-runtime-sources'
import { sessionTidyHoldReason } from '../session-manage/session-manage-tidy'
import {
  sessionOrganizationHostFor,
  sessionOrganizationValuesFor
} from '../session-organization/host-organization-instance'
import { mainConversationInventory } from './main-conversation-inventory'
import { startOwnerConversationLedger } from './main-conversation-ledger'
import { withMainInventoryRows } from './main-inventory-sidebar-rows'
import { readAwaitedSessionResult } from '../session-steward/steward-awaited-session'
import { setStewardRowsWithoutWindow } from '../session-steward/steward-runtime-sources'
import { setReviewWakeRowsWithoutWindow } from '../artifacts/artifact-review-wake-host'
import { publishHeadlessSessionArchives } from './headless-session-archive'
import { adoptHostSessions } from './host-session-adoption'
import { HostSessionInventory } from './host-session-inventory'
import { HostWaitRegistry, type HostWaitResultReader } from './host-wait-registry'
import {
  SessionHostOwnerExecutor,
  type SessionHostActionHandler
} from './session-host-owner-executor'
import { reconcileHostDeliveries } from './session-host-owner-reconcile'
import { sessionHostOwnerContext, type SessionHostOwnerContext } from './session-host-owner-context'
import type { OwnerDeliveryDeps } from './session-host-owner-delivery'
import { headlessSessionResume } from './session-host-headless-resume'
import { hasUncertainWaitRegistration } from './session-host-owner-waits'
import { remoteControlsOn } from './session-host-switches'
import { sessionHostTurnRevision, withEndedLeadTurn } from './session-host-turn'

const FIRST_PASS_MS = 5_000
// Why two minutes: each pass observes every local session (process table, hooks), eight at a time.
const PASS_EVERY_MS = 2 * 60_000
// Why: another computer's observe adopts a session started since the last pass, at most this often.
const REGISTER_AGAIN_AFTER_MS = 10_000

export type SessionHostOwnerStart = {
  runtime: OrcaRuntimeService
  userDataPath: string
  windowAttached(): boolean
  /** Package C's transfers and relocation; whichever of B and C lands second wires them. */
  actionHandlers?: (owner: SessionHostOwnerContext) => readonly SessionHostActionHandler[]
}

function withdraw(runtime: OrcaRuntimeService, rowKey: string, entryId: string, reason: string) {
  // Read and settle in one tick: the drain cannot take it between the two.
  const entry = runtime
    .readPromptQueue(rowKey)
    ?.entries.find((candidate) => candidate.id === entryId)
  if (entry?.state !== 'queued') {
    return false
  }
  runtime.settlePromptQueueEntry(rowKey, entryId, { state: 'failed', reason, unsent: true })
  return true
}

export function startSessionHostOwner(input: SessionHostOwnerStart): () => Promise<void> {
  const { runtime, userDataPath } = input
  const process = runtimeSessionHostProcess(runtime.getRuntimeId())
  const directory = join(userDataPath, 'session-host')
  const sources = createRuntimeObserveSources(runtime)
  const inventory = new HostSessionInventory({
    readWindowRows: () =>
      input.windowAttached()
        ? readSidebarRows(runtime)
        : Promise.reject(new Error('No window is attached.')),
    observe: (row) => observeSession(row, sources),
    cacheFile: join(directory, 'rows.json'),
    headlessRows: (remembered) => {
      const source = runtime.readOwnerConversationInventory()
      const inventory = source ? mainConversationInventory(source) : null
      return withMainInventoryRows(
        remembered,
        inventory,
        sessionOrganizationValuesFor(userDataPath)
      )
    }
  })
  const waits = new HostWaitRegistry(join(directory, 'waits.json'))
  const readLatestTurn = async (source: ConversationSource) =>
    withEndedLeadTurn(
      await readRuntimeLatestTurn(source, runtimeNeverReplied(runtime)),
      source,
      runtime.getLastAgentHookRowForPane(source.paneKey)
    )
  const control = runtimeControlDeps(runtime)
  const resumeHeadless = headlessSessionResume(runtime, inventory, userDataPath)
  const readWaitResult: HostWaitResultReader = (dependency, since) => {
    const registration = process.current()?.store.snapshot()?.conversations[dependency]
    const paneKey = registration?.binding?.paneKey
    const result = paneKey ? readAwaitedSessionResult(runtime, paneKey, since) : null
    return registration && result
      ? {
          ownerEpoch: registration.ownerEpoch,
          outcomeRevision: result.revision,
          at: result.at ?? Date.now()
        }
      : null
  }
  const deliveryDeps: OwnerDeliveryDeps = {
    delivery: runtimeDeliveryDeps(runtime),
    readEntry: (source, entryId) =>
      runtime
        .readPromptQueue(conversationSourceRowKey(source))
        ?.entries.find((entry) => entry.id === entryId) ?? null,
    withdrawIfQueued: (source, entryId, reason) =>
      withdraw(runtime, conversationSourceRowKey(source), entryId, reason),
    askWait: (source, entryId) => runtimeAskWaitDeps(runtime, source, entryId),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now()
  }
  let reconciled = false
  const actionHandlers: SessionHostActionHandler[] = []
  const executor = new SessionHostOwnerExecutor({
    inventory,
    readLatestTurn,
    delivery: deliveryDeps,
    controls: {
      control: {
        ...control,
        resume: (target) =>
          input.windowAttached() ? control.resume(target) : resumeHeadless(target)
      },
      answer: (session) => runtimeSessionAnswerDeps({ runtime }, session),
      answerQuarantine: new PersistentSessionAnswerQuarantine(userDataPath),
      notice: (summary) => {
        if (input.windowAttached()) {
          showSessionManageNotice(runtime, { kind: 'notice', summary })
        }
      }
    },
    organization: {
      host: () => sessionOrganizationHostFor(userDataPath),
      remotelyAwaited: (conversationId) =>
        waits.awaited(conversationId) ||
        hasUncertainWaitRegistration(process.current()?.store.snapshot() ?? null, conversationId)
    },
    tidy: {
      service: () => process.current(),
      holdFor: (row) => sessionTidyHoldReason(runtime.listSessionChains(), row),
      answerWait: () => answerWaitKeeper(runtime.getArtifactApiOrigin())
    },
    waits,
    readWaitResult,
    actionHandlers,
    reconciled: () => reconciled,
    register: () => registerSoon()
  })
  const owner = sessionHostOwnerContext({
    inventory,
    delivery: deliveryDeps,
    organization: () => sessionOrganizationHostFor(userDataPath),
    readTurn: (registration) => executor.readTurn(registration),
    store: () => process.current()?.store ?? null
  })
  actionHandlers.push(...(input.actionHandlers?.(owner) ?? []))
  process.installExecutor(executor)
  // Why: with no window the steward still runs its rules on the sessions this host executes.
  const restoreStewardRows = setStewardRowsWithoutWindow(async () => (await inventory.rows()).rows)
  // Why: a decision on a review page wakes its sleeping session with no window open too.
  const restoreReviewWakeRows = setReviewWakeRowsWithoutWindow(
    async () => (await inventory.rows()).rows
  )
  const stopPublishingArchives = publishHeadlessSessionArchives(runtime, inventory, userDataPath)
  // Why here too: tombstones in both modes, and the main-authored set while no window publishes.
  const stopConversationLedger = startOwnerConversationLedger(runtime, userDataPath)

  let stopped = false
  const sleepHeadless = runtimeHeadlessSessionSleep({
    runtime,
    inventory,
    userDataPath,
    enabled: () => !stopped && !input.windowAttached() && remoteControlsOn(),
    store: () => process.current()?.store ?? null
  })
  let passing: Promise<void> = Promise.resolve()
  let adoptedAt = 0
  let registering: Promise<void> | null = null
  // Why first and whatever the switches say: until it ends, adopted conversations admit nothing.
  const reconcile = async (): Promise<void> => {
    const service = await process.service()
    await reconcileHostDeliveries(service, {
      readQueue: (rowKey) => runtime.readPromptQueue(rowKey),
      withdraw: (rowKey, entryId, reason) => withdraw(runtime, rowKey, entryId, reason),
      readTurn: (registration) => executor.readTurn(registration)
    })
    for (const handler of actionHandlers) {
      await handler.reconcile?.()
    }
    reconciled = true
  }
  const pass = async (): Promise<void> => {
    if (!reconciled) {
      await reconcile()
    }
    if (stopped || !remoteControlsOn()) {
      return
    }
    const sessions = await adopt()
    await waits.refresh(readWaitResult)
    await sleepHeadless(sessions.map((session) => session.row))
  }
  const adopt = async () => {
    const service = await process.service()
    const sessions = await inventory.list()
    const turns = new Map<string, string | null>()
    await Promise.all(
      sessions.map(async (session) => {
        if (session.source && session.entry.verdict === 'live') {
          turns.set(
            session.row.rowKey,
            sessionHostTurnRevision(await readLatestTurn(session.source))
          )
        }
      })
    )
    await adoptHostSessions({
      store: service.store,
      sessions,
      turnRevision: (session) => turns.get(session.row.rowKey) ?? null
    })
    adoptedAt = Date.now()
    return sessions
  }
  // Why queued behind the pass: one adoption at a time writes the account's registry.
  const registerSoon = (): Promise<void> => {
    if (stopped || !reconciled || !remoteControlsOn()) {
      return Promise.resolve()
    }
    if (!registering) {
      passing = passing
        .then(async () => {
          if (!stopped && Date.now() - adoptedAt >= REGISTER_AGAIN_AFTER_MS) {
            await adopt()
          }
        })
        .catch((error: unknown) =>
          console.warn('[session-host] registering sessions failed', error)
        )
        .finally(() => {
          registering = null
        })
      registering = passing
    }
    return registering
  }
  const run = () => {
    passing = passing
      .then(pass)
      .catch((error: unknown) => console.warn('[session-host] owner pass failed', error))
  }
  passing = reconcile().catch((error: unknown) =>
    console.warn('[session-host] reconciling after the restart failed; it is retried', error)
  )
  const first = setTimeout(run, FIRST_PASS_MS)
  const interval = setInterval(run, PASS_EVERY_MS)
  first.unref?.()
  interval.unref?.()
  return async () => {
    stopped = true
    restoreStewardRows()
    restoreReviewWakeRows()
    stopPublishingArchives()
    // Why awaited below: this stop is in the quit barrier, and the ledger's write is coalesced.
    const conversationLedgerKept = stopConversationLedger()
    clearTimeout(first)
    clearInterval(interval)
    await passing
    await Promise.all([inventory.flush(), waits.flush().catch(() => {}), conversationLedgerKept])
  }
}
