/**
 * Session Questions on OmniOS, on this computer: keeps OmniOS holding exactly the questions this
 * computer's sessions wait on (a diff within seconds of a change, a full resync each minute) and
 * types in the answers the person gave there. Uses the signed-person console transport (the
 * backoffice base URL and the signed-in person's bearer), like the Work feed and session ledger.
 * Every failure is quiet and backs off; nothing here blocks the UI or logs a body or credential.
 */

import { z } from 'zod'
import { requestConsoleWorkflow } from '../backoffice/console-workflow-transport'
import { redactValue } from '../observability/redactor'
import { redactValueKeepingSignInLinks } from '../observability/sign-in-link-redaction'
import { currentLedgerPrincipal } from '../session-ledger/ledger-client'
import {
  OmniosQuestionPublisherState,
  runOmniosAnswerRound,
  type OmniosApplyOutcome,
  type OmniosQuestionAnswer,
  type OmniosQuestionItem,
  type OmniosQuestionSyncBody
} from './omnios-question-sync'

const CHANGE_CHECK_MS = 3_000
const FULL_SYNC_MS = 60_000
const ANSWER_POLL_MS = 10_000
const MAX_BACKOFF_MS = 5 * 60_000
const TIMEOUT_MS = 15_000

const syncSchema = z.object({ ok: z.boolean().optional() }).passthrough()
const ackSchema = z.object({}).passthrough()
const answersSchema = z.object({
  answers: z
    .array(
      z.object({
        id: z.string(),
        fingerprint: z.string(),
        paneKey: z.string().catch(''),
        sessionId: z.string().catch(''),
        toolUseId: z.string().catch(''),
        answers: z.record(z.string(), z.string()).catch({}),
        skipped: z.boolean().catch(false),
        deliveryKey: z.string().nullable().catch(null)
      })
    )
    .catch([])
})

export type OmniosQuestionTransport = {
  sync(body: OmniosQuestionSyncBody, account: string): Promise<boolean>
  answers(host: string, account: string): Promise<OmniosQuestionAnswer[] | null>
  ack(id: string, outcome: OmniosApplyOutcome, account: string): Promise<boolean>
}

/** Strict percent-encoding (also `!'()*`), so any host name fits the allowlisted route. */
export const encodeHostQuery = (host: string) =>
  encodeURIComponent(host).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )

const stillAccount = (account: string) => () => currentLedgerPrincipal() === account

export const consoleQuestionTransport: OmniosQuestionTransport = {
  async sync(body, account) {
    // Why redact here: the transport refuses a body its redactor would change. Sign-in links stay
    // whole on this route only (D1): telemetry and every other request still redact their tokens.
    const sent = await requestConsoleWorkflow(
      '/api/session-questions/sync',
      'POST',
      syncSchema,
      redactValueKeepingSignInLinks(body),
      TIMEOUT_MS,
      false,
      account,
      stillAccount(account)
    )
    return sent.ok
  },
  async answers(host, account) {
    const read = await requestConsoleWorkflow(
      `/api/session-questions/answers?host=${encodeHostQuery(host)}`,
      'GET',
      answersSchema,
      undefined,
      TIMEOUT_MS,
      false,
      account,
      stillAccount(account)
    )
    return read.ok ? read.data.answers : null
  },
  async ack(id, outcome, account) {
    if (!/^\d{1,19}$/.test(id)) {
      return false
    }
    const sent = await requestConsoleWorkflow(
      `/api/session-questions/${id}/ack`,
      'POST',
      ackSchema,
      redactValue(outcome.delivered ? { delivered: true } : outcome),
      TIMEOUT_MS,
      false,
      account,
      stillAccount(account)
    )
    // Why not_pending counts: nothing waits on it any more (acked earlier or answered again).
    return sent.ok || sent.error.code === 'not_pending'
  }
}

export type OmniosQuestionsDeps = {
  host: string
  list: () => Promise<OmniosQuestionItem[]>
  isPending: (fingerprint: string) => boolean
  apply: (answer: OmniosQuestionAnswer) => Promise<OmniosApplyOutcome>
  /** This runtime's session-host id, so OmniOS binds an answer's delivery to this computer. */
  hostId?: () => string | null | undefined
  transport?: OmniosQuestionTransport
  principal?: () => string | null
}

/** A loop that waits `base` between rounds, doubling (to a cap) while rounds fail. */
function loop(base: number, round: () => Promise<boolean>): () => void {
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  let wait = base
  const run = async (): Promise<void> => {
    const ok = await round().catch(() => false)
    wait = ok ? base : Math.min(wait * 2, MAX_BACKOFF_MS)
    if (!stopped) {
      timer = setTimeout(() => void run(), wait)
      timer.unref?.()
    }
  }
  timer = setTimeout(() => void run(), base)
  timer.unref?.()
  return () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export function createOmniosQuestionsSync(deps: OmniosQuestionsDeps) {
  const transport = deps.transport ?? consoleQuestionTransport
  const principal = deps.principal ?? currentLedgerPrincipal
  const state = new OmniosQuestionPublisherState()
  const unacked = new Set<string>()
  let account: string | null = null
  let lastFullAt: number | null = null
  let publishing = false

  /** One publish round; true when OmniOS is current (or there was nothing to send). */
  const publish = async (forceFull = false, now = Date.now()): Promise<boolean> => {
    const current = principal()
    if (!current) {
      return true
    }
    if (current !== account) {
      // Why: a different person signing in owns none of what was sent before.
      account = current
      state.reset()
      lastFullAt = null
    }
    if (publishing) {
      return true
    }
    publishing = true
    try {
      const full = forceFull || lastFullAt === null || now - lastFullAt >= FULL_SYNC_MS
      const body = state.next(deps.host, await deps.list(), full)
      if (!body) {
        return true
      }
      const hostId = deps.hostId?.()
      if (
        !(await transport.sync(hostId ? { ...body, hostId } : body, current).catch(() => false))
      ) {
        return false
      }
      state.accepted(body)
      if (full) {
        lastFullAt = now
      }
      return true
    } finally {
      publishing = false
    }
  }

  const collect = async (): Promise<boolean> => {
    const current = principal()
    if (!current) {
      return true
    }
    const round = await runOmniosAnswerRound({
      fetchAnswers: () => transport.answers(deps.host, current).catch(() => null),
      isPending: deps.isPending,
      apply: deps.apply,
      ack: (id, outcome) => transport.ack(id, outcome, current),
      unacked
    })
    if (round.delivered > 0) {
      void publish()
    }
    return round.ok
  }

  return { publish, collect }
}

export function startOmniosQuestionsSync(deps: OmniosQuestionsDeps): () => void {
  if (process.env.OMNI_SESSION_QUESTIONS_SYNC_DISABLED === '1') {
    return () => undefined
  }
  const sync = createOmniosQuestionsSync(deps)
  const stops = [loop(CHANGE_CHECK_MS, () => sync.publish()), loop(ANSWER_POLL_MS, sync.collect)]
  return () => {
    for (const stop of stops) {
      stop()
    }
  }
}
