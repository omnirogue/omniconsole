/** Test harness for Keep going: a real suggestion store and service over a fake prompt queue. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { NextStepAdPauses } from '../../shared/next-step-ad-pauses'
import type { NextStepKeepGoingStopReason } from '../../shared/next-step-keep-going'
import type { NextStepSuggestion, NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { PromptQueue } from '../../shared/prompt-queue-types'
import type { decideNextSteps } from './next-step-decisions'
import {
  NextStepKeepGoingController,
  type NextStepKeepGoingAttention
} from './next-step-keep-going'
import type { NextStepKeepGoingJudges } from './next-step-keep-going-judge'
import { NextStepKeepGoingStore } from './next-step-keep-going-store'
import { NextStepSuggestionService } from './next-step-suggestion-service'
import { NEXT_STEP_DECISIONS_FILE, NextStepSuggestionStore } from './next-step-suggestion-store'

export const conversation: ConversationSource = {
  worktreeId: 'repo::/w',
  paneKey: 'tab-1:leaf-1',
  kind: 'pty'
}
export const KEY = conversationSourceRowKey(conversation)
export const safe = (id: string, over: Partial<NextStepSuggestion> = {}): NextStepSuggestion => ({
  id,
  title: `Step ${id}`,
  prompt: `Please do step ${id}.`,
  risk: 'safe',
  kind: 'verify',
  ...over
})
export const risky = (id: string) => safe(id, { risk: 'risky', kind: 'ship' })
export const MARKER = /^\[Keep going (\d+)\/(\d+) · kg-[0-9a-f]{6}\] /

let dir = ''
/** Each test gets its own directory for the stores and the decision log. */
export function withKeepGoingDirectory(): () => string {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'next-step-keep-going-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return () => dir
}

export type HarnessOptions = {
  keepGoingMaxRounds?: number
  decide?: typeof decideNextSteps
  store?: NextStepKeepGoingStore
  judges?: NextStepKeepGoingJudges
}

export function harness(options: HarnessOptions = {}) {
  const flags = {
    enabled: true,
    chainBound: false,
    open: true,
    attention: null as NextStepKeepGoingAttention | null,
    refuse: null as string | null,
    /** The global ad-pause setting; undefined = absent (allowed). */
    adPauses: undefined as NextStepAdPauses | undefined
  }
  const queue: PromptQueue = { source: conversation, entries: [] }
  let controller: NextStepKeepGoingController | null = null
  const sets = new NextStepSuggestionStore({
    directory: dir,
    onChange: () => controller?.onSetsChanged()
  })
  let ids = 0
  const service = new NextStepSuggestionService({
    store: sets,
    settings: () => ({
      enabled: flags.enabled,
      ...(options.keepGoingMaxRounds ? { keepGoingMaxRounds: options.keepGoingMaxRounds } : {}),
      ...(flags.adPauses ? { adPauses: flags.adPauses } : {})
    }),
    readPromptQueue: () => queue,
    isChainBound: () => flags.chainBound,
    enqueue: (_source, input) => {
      if (flags.refuse) {
        throw new Error(flags.refuse)
      }
      queue.entries.push({ ...input, createdAt: 1, state: 'queued' })
    },
    generate: vi.fn(),
    newId: () => `set-${++ids}`
  })
  const store = options.store ?? new NextStepKeepGoingStore({ directory: dir })
  let tokens = 0
  controller = new NextStepKeepGoingController({
    service,
    store,
    readAttention: () => flags.attention,
    isConversationOpen: () => flags.open,
    listPromptQueues: () => ({ [KEY]: queue }),
    withdrawQueued: (_source, entryId, reason) => {
      queue.entries = queue.entries.map((entry) =>
        entry.id === entryId && entry.state === 'queued'
          ? { ...entry, state: 'failed' as const, reason }
          : entry
      )
      return true
    },
    newToken: () => (++tokens).toString(16).padStart(6, '0'),
    ...(options.decide ? { decide: options.decide } : {}),
    ...options.judges
  })
  const keepGoing = controller
  let clock = 1_000
  let order = 0
  /** The host observes a turn (by its own order) before it writes that turn's sets. */
  const observe = (turnKey: string, at = ++order) =>
    service.currentTurns.set(KEY, { turnKey, order: at })
  const offer = (
    turnKey: string,
    suggestions: NextStepSuggestion[],
    origin: NextStepSuggestionSet['origin'] = 'ai',
    status: NextStepSuggestionSet['status'] = 'pending'
  ): NextStepSuggestionSet => {
    if (service.currentTurns.get(KEY)?.turnKey !== turnKey) {
      observe(turnKey)
    }
    return sets.upsert(service.newSet({ conversation, turnKey }, origin, status, suggestions))
  }
  /** The drain delivers everything queued. */
  const deliver = () => {
    queue.entries = queue.entries.map((entry) =>
      entry.state === 'queued'
        ? { ...entry, state: 'delivered' as const, deliveredAt: ++clock }
        : entry
    )
  }
  /** A turn finishes; the host then makes it current only when it is later. */
  const finish = (
    turnKey: string,
    lastUserPrompt?: string,
    placement: { order?: number | null; completedAt?: number; reply?: string } = {}
  ) => {
    const turnOrder = placement.order === undefined ? order + 1 : placement.order
    keepGoing.onTurnSignal({
      kind: 'finished',
      turn: {
        conversation,
        turnKey,
        lastAssistantMessage: placement.reply ?? 'Done.',
        completedAt: placement.completedAt ?? ++clock,
        ...(lastUserPrompt !== undefined ? { lastUserPrompt } : {}),
        ...(turnOrder !== null ? { order: turnOrder } : {})
      }
    })
    if (turnOrder !== null && turnOrder > order) {
      order = turnOrder
      observe(turnKey, turnOrder)
    }
  }
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 4; round++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      await sets.flush()
    }
  }
  const state = () => keepGoing.list({ conversation })[0]
  /** What is waiting or was sent: withdrawn entries are failed, never sent. */
  const sent = () => queue.entries.filter((entry) => entry.state !== 'failed').map((e) => e.text)
  const lastSent = () => sent().at(-1)!
  const expectStopped = (reason: NextStepKeepGoingStopReason) =>
    expect(state()).toMatchObject({ enabled: false, stopReason: reason })
  const log = () =>
    readFileSync(join(dir, NEXT_STEP_DECISIONS_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  /** One full round: enable, an AI set for t1, its prompt queued and delivered. */
  const firstRound = async (max = 3) => {
    keepGoing.setKeepGoing(conversation, true, max)
    offer('t1', [safe('s1')])
    await settle()
    deliver()
  }
  return {
    flags,
    queue,
    sets,
    service,
    store,
    keepGoing,
    offer,
    observe,
    deliver,
    finish,
    settle,
    state,
    sent,
    lastSent,
    log,
    expectStopped,
    firstRound
  }
}
