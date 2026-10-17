import { z } from 'zod'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import {
  LEDGER_ID_PATTERN,
  ledgerEventsAcceptedSchema,
  ledgerNowResponseSchema,
  ledgerPeersResponseSchema,
  ledgerRegisterResponseSchema,
  type LedgerEventBatch,
  type LedgerNowResult,
  type LedgerPeersResult,
  type LedgerRegisterBody,
  type LedgerUnavailableReason
} from '../../shared/session-ledger-contract'
import { currentConsolePublicationScope } from '../backoffice/console-workflow-person'
import { requestConsoleWorkflow } from '../backoffice/console-workflow-transport'
import type { LedgerSendFailureReason, LedgerSendResult } from './ledger-event-queue'

/** Events are fire-and-forget; a slow console must not hold a quit or a queue for the default 15 s. */
export const LEDGER_EVENTS_TIMEOUT_MS = 5_000

const SIGNED_OUT_CODES = new Set(['signed_in_required', 'backoffice_unconfigured'])
const OFFLINE_CODES = new Set(['backoffice_unavailable'])
/** The transport refused because the signed-in person is not the one the request is bound to. */
const PRINCIPAL_MISMATCH_CODES = new Set(['principal_mismatch', 'connection_changed'])

/** The console derives "today" from the caller's zone (`X-Omni-Timezone`), falling back to /api/me. */
export const OMNI_TIMEZONE_HEADER = 'X-Omni-Timezone'

export function timezoneHeaders(): Record<string, string> {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return zone ? { [OMNI_TIMEZONE_HEADER]: zone } : {}
  } catch {
    return {}
  }
}

export function currentLedgerPrincipal(): string | null {
  try {
    return currentConsolePublicationScope()?.principal ?? null
  } catch {
    return null
  }
}

export function unavailableReason(error: { code: string }): LedgerUnavailableReason {
  if (SIGNED_OUT_CODES.has(error.code)) {
    return 'signed-out'
  }
  if (OFFLINE_CODES.has(error.code)) {
    return 'offline'
  }
  return 'unavailable'
}

/** 4xx statuses that mean "try later", not "this body is refused". */
const TRANSIENT_CLIENT_STATUSES = new Set([408, 429])

/** One mapping for every ledger write: events and register fail the same way. */
function writeResult(result: ConsoleWorkflowResult<unknown>): LedgerSendResult {
  if (result.ok) {
    return { ok: true }
  }
  if (PRINCIPAL_MISMATCH_CODES.has(result.error.code)) {
    return { ok: false, reason: 'principal-mismatch' }
  }
  const reason = unavailableReason(result.error)
  if (reason !== 'unavailable') {
    return { ok: false, reason }
  }
  const status = result.error.status ?? 0
  // Why: an expired or not-yet-refreshed bearer is a transient of the same account — held
  // with backoff, never given up — whatever code the console put in the body.
  if (status === 401 || status === 403) {
    return { ok: false, reason: 'signed-out' }
  }
  // Why: any other 4xx is the console refusing this body's shape; retrying the same bytes cannot help.
  const rejected = status >= 400 && status < 500 && !TRANSIENT_CLIENT_STATUSES.has(status)
  return { ok: false, reason: rejected ? 'rejected' : 'unavailable' }
}

export type LedgerTransport = typeof requestConsoleWorkflow

/**
 * The ledger's four console calls over the signed-person transport. Never throws. Writes
 * are bound to the account they originated under: the transport refuses any other bearer.
 */
export function createSessionLedgerClient(
  request: LedgerTransport = requestConsoleWorkflow,
  currentPrincipal: () => string | null = currentLedgerPrincipal
) {
  const stillThatAccount = (account: string) => () => currentPrincipal() === account
  return {
    async events(batch: LedgerEventBatch, account: string): Promise<LedgerSendResult> {
      try {
        return writeResult(
          await request(
            '/api/agent-sessions/events',
            'POST',
            ledgerEventsAcceptedSchema,
            batch,
            LEDGER_EVENTS_TIMEOUT_MS,
            false,
            account,
            stillThatAccount(account),
            undefined,
            timezoneHeaders()
          )
        )
      } catch {
        return { ok: false, reason: 'unavailable' }
      }
    },

    async now(scope: 'live' | 'today'): Promise<LedgerNowResult> {
      try {
        const result = await request(
          `/api/agent-sessions/now?scope=${scope === 'today' ? 'today' : 'live'}`,
          'GET',
          ledgerNowResponseSchema,
          undefined,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          timezoneHeaders()
        )
        return result.ok
          ? {
              ok: true,
              rows: result.data.rows,
              overflow: result.data.overflow,
              server_time: result.data.server_time
            }
          : { ok: false, reason: unavailableReason(result.error) }
      } catch {
        return { ok: false, reason: 'unavailable' }
      }
    },

    async peers(ledgerId: string): Promise<LedgerPeersResult> {
      if (!LEDGER_ID_PATTERN.test(ledgerId)) {
        return { ok: false, reason: 'unavailable' }
      }
      try {
        const result = await request(
          `/api/agent-sessions/${ledgerId}/peers`,
          'GET',
          ledgerPeersResponseSchema,
          undefined,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          timezoneHeaders()
        )
        return result.ok
          ? { ok: true, peers: result.data.peers }
          : { ok: false, reason: unavailableReason(result.error) }
      } catch {
        return { ok: false, reason: 'unavailable' }
      }
    },

    async register(
      ledgerId: string,
      body: LedgerRegisterBody,
      account: string
    ): Promise<{ ok: true } | { ok: false; reason: LedgerSendFailureReason }> {
      if (!LEDGER_ID_PATTERN.test(ledgerId)) {
        return { ok: false, reason: 'rejected' }
      }
      try {
        const result = await request(
          `/api/agent-sessions/${ledgerId}/register`,
          'POST',
          ledgerRegisterResponseSchema,
          body,
          LEDGER_EVENTS_TIMEOUT_MS,
          false,
          account,
          stillThatAccount(account),
          undefined,
          timezoneHeaders()
        )
        return writeResult(result)
      } catch {
        return { ok: false, reason: 'unavailable' }
      }
    }
  }
}

export type SessionLedgerClient = ReturnType<typeof createSessionLedgerClient>

export const sessionLedgerClient: SessionLedgerClient = createSessionLedgerClient()

/** IPC argument validators: the renderer's inputs are untrusted at the main boundary. */
export const ledgerScopeSchema = z.enum(['live', 'today'])
export const ledgerIdSchema = z.string().regex(LEDGER_ID_PATTERN)
export const ledgerRepoSchema = z.string().min(1).max(300)
