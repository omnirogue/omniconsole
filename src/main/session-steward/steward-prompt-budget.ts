/**
 * S1's `promptBudget` hook: every unattended Yes, nudge or question (the rules loop's, or an
 * automatic cleanup session's) spends its per-session limit (and adds to today's count) in the durable state before
 * anything is queued; a prompt that sent nothing gives them back. An intent a crash left unsettled
 * stays spent and is never resent.
 */

import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type {
  StewardPromptBudget,
  StewardPromptGrant,
  StewardPromptRequest
} from '../session-manage/session-manage-unattended-admission'
import {
  askAllowance,
  nudgeAllowance,
  promptsToday,
  yesAllowance,
  type StewardAllowance,
  type StewardYesReading
} from './steward-caps'
import {
  stewardDay,
  type StewardIntent,
  type StewardSessionState,
  type StewardStateData,
  type StewardStateStore
} from './steward-state-store'

/** A grant whose settle never came (a hang, a crash) is settled as spent after this long. */
export const STEWARD_INTENT_STALE_MS = 5 * 60_000
/** Starts every limit refusal, so a caller can tell "limit reached" from a delivery refusal. */
export const STEWARD_LIMIT_PREFIX = 'Steward limit: '

export function isStewardLimitRefusal(message: string): boolean {
  return message.startsWith(STEWARD_LIMIT_PREFIX)
}

export type StewardPromptBudgetDeps = {
  store: StewardStateStore
  now: () => number
  newId: () => string
  readTurnKey: (source: ConversationSource) => Promise<string | null>
  /** Git head plus working-tree changes of the target's workspace; null when unreadable. */
  readEvidence: (source: ConversationSource) => Promise<string | null>
}

type Field = 'yes' | 'nudge' | 'ask'

const FIELD: Record<StewardPromptRequest['kind'], Field> = {
  yes: 'yes',
  prompt: 'nudge',
  ask: 'ask'
}

/** The per-session key the limits are kept under: the pane every session command addresses. */
export function stewardSessionKey(
  entry: { paneKey: string | null },
  source: ConversationSource
): string {
  return entry.paneKey ?? conversationSourceRowKey(source)
}

function allowance(
  request: StewardPromptRequest,
  session: StewardSessionState,
  reading: StewardYesReading,
  now: number
): StewardAllowance<unknown> {
  switch (request.kind) {
    case 'yes':
      return yesAllowance(session.yes, reading, stewardDay(now))
    case 'prompt':
      return nudgeAllowance(session.nudge, now, reading.turnKey)
    case 'ask':
      return askAllowance(session.ask, now, reading.turnKey)
  }
}

export function createStewardPromptBudget(deps: StewardPromptBudgetDeps): StewardPromptBudget {
  return async (request): Promise<StewardPromptGrant> => {
    const key = stewardSessionKey(request.entry, request.source)
    const [turnKey, evidence] = await Promise.all([
      deps.readTurnKey(request.source).catch(() => null),
      request.kind === 'yes'
        ? deps.readEvidence(request.source).catch(() => null)
        : Promise.resolve(null)
    ])
    const now = deps.now()
    const day = stewardDay(now)
    const id = deps.newId()
    const field = FIELD[request.kind]
    const granted = await deps.store.transact((data) => {
      const session: StewardSessionState = data.sessions[key] ?? { updatedAt: now }
      const verdict = allowance(request, session, { turnKey, evidence }, now)
      if (!verdict.ok) {
        return { ok: false as const, reason: `${STEWARD_LIMIT_PREFIX}${verdict.reason}` }
      }
      data.daily = { day, prompts: promptsToday(data.daily, day) + 1 }
      data.sessions[key] = {
        ...session,
        [field]: verdict.next,
        title: request.entry.title,
        updatedAt: now
      }
      data.intents.push({ id, paneKey: key, kind: request.kind, at: now })
      return { ok: true as const, previous: session[field] }
    })
    if (!granted.ok) {
      return granted
    }
    return {
      ok: true,
      settle: (queued) => {
        void deps.store
          .transact((data) => {
            data.intents = data.intents.filter((intent) => intent.id !== id)
            if (queued) {
              return
            }
            // Why give it back: nothing was sent, so no limit was used.
            if (data.daily.day === day) {
              data.daily.prompts = Math.max(0, data.daily.prompts - 1)
            }
            const current = data.sessions[key]
            if (current) {
              data.sessions[key] = { ...current, [field]: granted.previous, updatedAt: now }
            }
          })
          .catch((error: unknown) =>
            console.warn('[session-steward] settling a prompt failed', error)
          )
      }
    }
  }
}

const ACTIVITY_OF: Record<StewardIntent['kind'], 'yes' | 'nudge' | 'ask'> = {
  yes: 'yes',
  prompt: 'nudge',
  ask: 'ask'
}

/**
 * Intents with no settle (left by a crash, or older than `STEWARD_INTENT_STALE_MS`): their limits
 * stay spent and they are recorded, never resent. Returns the ones it settled.
 */
export function settleStaleIntents(
  data: StewardStateData,
  now: number,
  all = false
): StewardIntent[] {
  const stale = data.intents.filter((intent) => all || now - intent.at >= STEWARD_INTENT_STALE_MS)
  if (stale.length === 0) {
    return []
  }
  data.intents = data.intents.filter((intent) => !stale.includes(intent))
  for (const intent of stale) {
    data.activity.push({
      at: now,
      kind: ACTIVITY_OF[intent.kind],
      paneKey: intent.paneKey,
      ...(data.sessions[intent.paneKey]?.title
        ? { title: data.sessions[intent.paneKey]!.title }
        : {}),
      summary:
        'A steward prompt was interrupted before it was confirmed; it was counted and is not sent again.'
    })
  }
  return stale
}
