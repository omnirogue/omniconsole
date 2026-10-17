/**
 * A whole steward on fakes for tests: sidebar rows and their observations are set per test, JEV
 * answers from a table, and every action goes through the real continue/ask/archive paths into a
 * fake queue and window, with the real prompt limits, Tier 2 check, state and card stores on disk.
 */

import { join } from 'node:path'
import { vi } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import type { NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import { conversationMutationGeneration } from '../runtime/conversation-mutation-generation'
import type { SessionChain } from '../../shared/session-chain-types'
import { SessionActionsLog } from '../session-manage/session-actions-log'
import type { SessionDeliveryDeps } from '../session-manage/session-manage-deliver'
import { UNREAD_TURN, type SessionLatestTurn } from '../session-manage/session-manage-freeform'
import type { ObservedSession } from '../session-manage/session-manage-observe'
import { sessionManageSource } from '../session-manage/session-manage-observe'
import type { SessionAgentActivity } from '../session-manage/session-manage-state'
import { NO_OWN_STEPS, type SessionOwnSteps } from '../session-manage/session-manage-steps'
import { agentProcess, sidebarRow } from '../session-manage/session-manage-test-fixtures'
import { setStewardPolicyHooks } from '../session-manage/session-manage-unattended-admission'
import { OrganizationChangeLedger } from '../session-organization/organization-change-ledger'
import { OrganizationHistoryStore } from '../session-organization/organization-history-store'
import { createStewardActions } from './steward-actions'
import type { StewardDoneness, StewardJev } from './steward-jev'
import { emptyStewardPassMemory, type StewardPassDeps } from './steward-pass'
import { createStewardPromptBudget } from './steward-prompt-budget'
import { StewardResultCardStore } from './steward-result-card'
import type { StewardPromptedReading } from './steward-empty-session'
import type { StewardStalledWaiter } from './steward-stalled-waiters'
import { StewardStateStore } from './steward-state-store'
import { configureStewardSwitches } from './steward-switches'
import { createStewardTier2Check, type StewardTier2Deps } from './steward-tier2-check'
import { withUnreachableBlankRule } from './steward-remote-blank'
import { fakeStewardWindow } from './steward-test-window'
import type { StewardLastHookRow } from './steward-remote-blank-rule'

export const HOUR = 60 * 60_000

export type FakeSession = {
  row: SessionManageSidebarRow
  activity: SessionAgentActivity
  verdict?: ObservedSession['facts']['verdict']
  pendingSteps?: string[]
  queueLength?: number
  keepGoing?: boolean
  lastActivityAt: number | null
  turn: SessionLatestTurn
  own?: SessionOwnSteps
  /** Whether a person has asked it anything; a person has, unless a test says otherwise. */
  prompted?: StewardPromptedReading
  /** Whether the process table shows its agent holding the terminal (true unless set). */
  agentForeground?: boolean | null
  /** Its newest hook report, as the third rule reads it. */
  hook?: StewardLastHookRow | null
}

export function fakeSession(
  paneKey: string,
  overrides: Partial<Omit<FakeSession, 'row'>> & { row?: Partial<SessionManageSidebarRow> } = {}
): FakeSession {
  const { row, ...rest } = overrides
  return {
    row: sidebarRow({
      paneKey,
      tabId: `tab-${paneKey}`,
      rowKey: `row-${paneKey}`,
      viewKey: `view-${paneKey}`,
      title: `Session ${paneKey}`,
      doneArchiveRevision: 'done',
      doneArchivePolicy: { revision: 'done', since: 1, delayMs: 2 * HOUR },
      emptyArchiveRevision: 'empty',
      ...row
    }),
    activity: { kind: 'idle' },
    lastActivityAt: 0,
    turn: {
      known: true,
      turnKey: `turn-${paneKey}-1`,
      text: 'I fixed the parser and the tests pass.',
      complete: true,
      proposal: null,
      empty: false
    },
    ...rest
  }
}

export function ownStep(
  session: FakeSession,
  step: { title: string; prompt?: string; why?: string }
): SessionOwnSteps {
  const set = {
    id: `set-${session.row.paneKey}`,
    conversation: sessionManageSource(session.row),
    worktreeId: session.row.worktreeId,
    turnKey: session.turn.turnKey,
    origin: 'parsed',
    createdAt: 1,
    status: 'pending',
    suggestions: [
      {
        id: 'step-1',
        title: step.title,
        prompt: step.prompt ?? `Please go ahead with this next step you suggested: ${step.title}`,
        ...(step.why ? { why: step.why } : {}),
        risk: 'safe',
        kind: 'fix',
        offered: true
      }
    ]
  } as NextStepSuggestionSet
  return { set, steps: set.suggestions }
}

export function observed(session: FakeSession): ObservedSession {
  const source = sessionManageSource(session.row)
  return {
    row: session.row,
    source,
    terminal: `term-${session.row.paneKey}`,
    facts: {
      verdict: session.verdict ?? 'live',
      activity: session.activity,
      queueLength: session.queueLength ?? 0,
      pendingSteps: session.pendingSteps ?? []
    },
    stateBasis: 'hook',
    agentForeground: session.agentForeground ?? true,
    agentProcess: agentProcess(),
    lastActivityAt: session.lastActivityAt,
    keepGoing: session.keepGoing ?? false
  }
}

export type StewardHarness = ReturnType<typeof createStewardHarness>

export function createStewardHarness(dir: string) {
  const clock = { now: 10 * 24 * HOUR }
  const sessions = new Map<string, FakeSession>()
  const doneness = new Map<string, StewardDoneness>()
  const jevState = {
    off: null as string | null,
    advances: 4 as number | null,
    goal: 'Fix the parser'
  }
  const chains: SessionChain[] = []
  const stalledWaiters = new Map<string, StewardStalledWaiter>()
  const settings: Record<string, unknown> = {}
  const env: Record<string, string | undefined> = {}
  const cleanups: (() => void)[] = [
    configureStewardSwitches({ readSettings: () => settings, environment: env })
  ]
  const find = (source: ConversationSource) =>
    [...sessions.values()].find((session) => session.row.paneKey === source.paneKey)
  const readRows = vi.fn(async () => [...sessions.values()].map((session) => session.row))
  const observe = vi.fn(async (row: SessionManageSidebarRow) =>
    observed(sessions.get(row.paneKey!)!)
  )
  const latestTurn = vi.fn(async (source: ConversationSource) => find(source)?.turn ?? UNREAD_TURN)
  const jev: StewardJev = {
    offReason: () => jevState.off,
    goal: async () => jevState.goal,
    doneness: vi.fn(async ({ turnKey }) => (jevState.off ? null : (doneness.get(turnKey) ?? null))),
    advances: vi.fn(async () => (jevState.off ? null : jevState.advances))
  }
  const ledgerStore = new OrganizationHistoryStore({ directory: join(dir, 'session-organization') })
  ledgerStore.load()
  const audit = new SessionActionsLog(dir)
  const ledger = new OrganizationChangeLedger({ trail: audit, store: ledgerStore })
  const cards = new StewardResultCardStore(dir)
  const state = new StewardStateStore({
    directory: join(dir, 'session-steward'),
    now: () => clock.now
  })
  const tier2: StewardTier2Deps = {
    readRows,
    observe,
    readCompletion: async () => ({ finishReady: true, archiveHasWork: false }),
    reviewArchive: async () => ({ kind: 'answer-delivered', evidence: 'synthetic archive review' }),
    personPrompted: async (row) => sessions.get(row.paneKey!)?.prompted ?? 'person',
    mutationGeneration: (row) => conversationMutationGeneration(row.rowKey),
    chains: () => chains,
    heldDelivery: () => false,
    lastHookAt: () => null,
    lastHookRow: (paneKey) => sessions.get(paneKey)?.hook ?? null,
    queuedPrompts: (row) => sessions.get(row.paneKey!)?.queueLength ?? 0,
    lastPersonActionAt: async () => null,
    latestTurn,
    jev,
    cardFacts: async () => ({
      goal: jevState.goal,
      changed: { files: ['src/parser.ts'], branch: 'feat/parser' },
      chains: [],
      linkedDocs: []
    }),
    saveCard: (card) => cards.save(card),
    readCard: (key) => cards.read(key),
    now: () => clock.now
  }
  const delivery: SessionDeliveryDeps = {
    enqueue: vi.fn(),
    admission: vi.fn(() => null),
    bind: vi.fn(() => () => {}),
    readLatestTurn: vi.fn(async (source) => find(source)?.turn ?? UNREAD_TURN),
    snapshotLatestTurn: vi.fn((source) => find(source)?.turn ?? UNREAD_TURN),
    hasUnresolvedDraft: vi.fn(() => false),
    decideRelayed: vi.fn(async (_setId: string, suggestionId: string) => ({
      set: {} as NextStepSuggestionSet,
      queued: [suggestionId],
      notQueued: []
    })),
    stopKeepGoing: vi.fn(() => false),
    keepGoingOn: vi.fn((source) => find(source)?.keepGoing === true),
    readOwnSteps: vi.fn(async (source) => find(source)?.own ?? NO_OWN_STEPS),
    newId: () => `id-${Math.random().toString(36).slice(2)}`
  }
  const window = fakeStewardWindow(sessions)
  cleanups.push(
    setStewardPolicyHooks({
      tier2Eligibility: withUnreachableBlankRule(createStewardTier2Check(tier2), tier2),
      promptBudget: createStewardPromptBudget({
        store: state,
        now: () => clock.now,
        newId: () => `intent-${Math.random().toString(36).slice(2)}`,
        readTurnKey: async (source) => find(source)?.turn.turnKey ?? null,
        readEvidence: async () => 'head-1|clean'
      })
    })
  )
  const detector = { run: vi.fn(async () => {}) }
  const deps: StewardPassDeps = {
    readRows,
    signature: (row) => JSON.stringify([row, sessions.get(row.paneKey!)?.turn.turnKey]),
    observe,
    drivers: () => ({ chainBound: false, heldDelivery: false }),
    readOwnSteps: async (source) => find(source)?.own ?? NO_OWN_STEPS,
    latestTurn,
    lastOutputAt: async () => null,
    jev,
    tier2,
    store: state,
    act: createStewardActions({
      delivery: () => delivery,
      ledger: () => ledger,
      relay: window,
      audit: () => audit,
      stopWatch: window.stopWatch
    }),
    detector,
    stalledWaiters: () => stalledWaiters,
    now: () => clock.now
  }
  return {
    clock,
    sessions,
    doneness,
    jevState,
    chains,
    stalledWaiters,
    settings,
    env,
    deps,
    memory: emptyStewardPassMemory(),
    delivery,
    window,
    ledger,
    cards,
    state,
    detector,
    add(session: FakeSession) {
      sessions.set(session.row.paneKey!, session)
      return session
    },
    async dispose() {
      while (cleanups.length) {
        cleanups.pop()!()
      }
      await ledger.flush()
      await state.flush()
      await audit.flush()
    }
  }
}
