import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { requestConsoleWorkflow } from '../backoffice/console-workflow-transport'
import { redactValue } from '../observability/redactor'
import { currentLedgerPrincipal, unavailableReason } from '../session-ledger/ledger-client'
import type { SessionSearchService } from '../session-search/session-search-service'
import {
  buildWorkFeedPosts,
  workFeedFingerprint,
  workFeedPostKey,
  workFeedWorkerMarkers,
  type WorkFeedPost,
  type WorkFeedPublication
} from './work-feed-posts'

/**
 * Posts this computer's work sessions to the omnios Work feed, as the person signed in to this
 * app: the last eight days on the first run (the backfill), then every five minutes whatever
 * changed. A post goes again only when its session or summary changed; a failed batch is
 * retried next round. Signed out, nothing is sent; a different person signing in starts over.
 */

export const WORK_FEED_WINDOW_MS = 8 * 24 * 60 * 60_000
const FIRST_RUN_DELAY_MS = 3 * 60_000
const INTERVAL_MS = 5 * 60_000
const BATCH = 50
const ROWS_MAX = 10_000
const TIMEOUT_MS = 20_000
const STATE_VERSION = 1

const acceptedSchema = z.object({
  accepted: z.number().int(),
  rejected: z
    .array(z.object({ index: z.number().int(), code: z.string().optional() }).passthrough())
    .catch([])
})

type State = {
  version: number
  principal: string | null
  sent: Record<string, { fp: string; at: number }>
}

export type WorkFeedSendResult =
  | { ok: true; rejected: number[] }
  | { ok: false; reason: 'signed-out' | 'offline' | 'unavailable' | 'rejected' }

export type WorkFeedDeps = {
  service: () => SessionSearchService | null
  userDataPath: string
  host: string
  principal?: () => string | null
  send?: (posts: WorkFeedPublication[], account: string) => Promise<WorkFeedSendResult>
  now?: () => number
}

export async function sendWorkFeedPosts(
  posts: WorkFeedPublication[],
  account: string
): Promise<WorkFeedSendResult> {
  try {
    const result = await requestConsoleWorkflow(
      '/api/team-feed/work-posts',
      'POST',
      acceptedSchema,
      { posts },
      TIMEOUT_MS,
      false,
      account,
      () => currentLedgerPrincipal() === account
    )
    if (result.ok) {
      return { ok: true, rejected: result.data.rejected.map((entry) => entry.index) }
    }
    const reason = unavailableReason(result.error)
    if (reason !== 'unavailable') {
      return { ok: false, reason }
    }
    const status = result.error.status ?? 0
    return {
      ok: false,
      reason: status >= 400 && status < 500 && status !== 429 ? 'rejected' : 'unavailable'
    }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

function statePath(userDataPath: string): string {
  return join(userDataPath, 'work-feed', 'posted-v1.json')
}

export function loadWorkFeedState(userDataPath: string): State {
  try {
    const parsed = JSON.parse(readFileSync(statePath(userDataPath), 'utf8')) as State
    if (parsed?.version === STATE_VERSION && parsed.sent && typeof parsed.sent === 'object') {
      return parsed
    }
  } catch {
    // Missing or unreadable: the next round posts the whole window again, which is idempotent.
  }
  return { version: STATE_VERSION, principal: null, sent: {} }
}

function saveState(userDataPath: string, state: State): void {
  const path = statePath(userDataPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(state))
  renameSync(`${path}.tmp`, path)
}

/** One round; returns how many posts the console accepted. Never throws. */
export async function runWorkFeedRound(deps: WorkFeedDeps): Promise<number> {
  const now = deps.now?.() ?? Date.now()
  const account = (deps.principal ?? currentLedgerPrincipal)()
  const service = deps.service()
  if (!account || !service) {
    return 0
  }
  let rows
  try {
    rows = await service.feedRows({ sinceMs: now - WORK_FEED_WINDOW_MS, limit: ROWS_MAX })
  } catch {
    return 0
  }
  const helperDirs = [deps.userDataPath]
  // Why redactValue: the transport refuses a body its redactor would change, so every post
  // is sent as that fixed point (and the console scrubs again before it stores anything).
  const posts = buildWorkFeedPosts(rows, deps.host, helperDirs).map(
    (post) => redactValue(post) as WorkFeedPost
  )
  let state = loadWorkFeedState(deps.userDataPath)
  if (state.principal !== account) {
    state = { version: STATE_VERSION, principal: account, sent: {} }
  }
  const due: WorkFeedPublication[] = [
    ...posts
      .filter((post) => state.sent[workFeedPostKey(post)]?.fp !== workFeedFingerprint(post))
      .sort((a, b) => b.last_at - a.last_at),
    // An older client may publish a worker after an earlier marker found no stored post.
    ...workFeedWorkerMarkers(rows)
  ]
  const send = deps.send ?? sendWorkFeedPosts
  let accepted = 0
  for (let start = 0; start < due.length; start += BATCH) {
    const batch = due.slice(start, start + BATCH)
    const result = await send(batch, account)
    if (!result.ok && result.reason !== 'rejected') {
      break
    }
    // Why a refused batch is remembered: the same bytes would be refused again every round.
    const refused = new Set(result.ok ? result.rejected : batch.map((_post, index) => index))
    batch.forEach((post, index) => {
      if (post.source_kind !== 'internal_worker') {
        state.sent[workFeedPostKey(post)] = { fp: workFeedFingerprint(post), at: post.last_at }
      }
      if (!refused.has(index)) {
        accepted += 1
      }
    })
    saveState(deps.userDataPath, state)
  }
  const oldest = now - WORK_FEED_WINDOW_MS
  const before = Object.keys(state.sent).length
  for (const [key, entry] of Object.entries(state.sent)) {
    if (entry.at < oldest) {
      delete state.sent[key]
    }
  }
  if (Object.keys(state.sent).length !== before) {
    saveState(deps.userDataPath, state)
  }
  return accepted
}

export function startWorkFeedPublisher(deps: WorkFeedDeps): () => void {
  if (process.env.OMNI_WORK_FEED_DISABLED === '1') {
    return () => undefined
  }
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  const run = async (): Promise<void> => {
    await runWorkFeedRound(deps).catch((error: unknown) =>
      console.error('[work-feed] round failed:', error)
    )
    if (!stopped) {
      timer = setTimeout(() => void run(), INTERVAL_MS)
      timer.unref?.()
    }
  }
  timer = setTimeout(() => void run(), FIRST_RUN_DELAY_MS)
  timer.unref?.()
  return () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
    }
  }
}
