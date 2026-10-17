/**
 * "Keep going" state per conversation, on this host's disk only so the tray can say why it
 * stopped. `next-step-keep-going.json` holds at most 100 conversations; on load every one that
 * was on reads back as stopped (`restarted`) — it never resumes after a restart.
 */

import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  conversationSourceRowKey,
  normalizeConversationSource
} from '../../shared/conversation-source'
import { NEXT_STEP_AD_PAUSES } from '../../shared/next-step-ad-pauses'
import {
  normalizeKeepGoingMode,
  normalizeKeepGoingPushPrompt,
  normalizeKeepGoingRounds,
  type NextStepKeepGoingState,
  type NextStepKeepGoingStopReason
} from '../../shared/next-step-keep-going'
import { salvagingArray } from '../../shared/zod-salvage'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'

export const NEXT_STEP_KEEP_GOING_FILE = 'next-step-keep-going.json'
export const NEXT_STEP_KEEP_GOING_MAX_ENTRIES = 100

const STOP_REASONS = [
  'person-stopped',
  'restarted',
  'cap-reached',
  'needs-you-risky',
  'no-safe-suggestion',
  'needs-you-question',
  'needs-you-ad-spend',
  'needs-you-ad-pause',
  'needs-you-ad-campaign-pause',
  'needs-you-ad-enterprise',
  'needs-you-deploy',
  'needs-you-shared-branch',
  'needs-you-delete-data',
  'needs-you-history',
  'needs-you-send',
  'needs-you-payment',
  'needs-you-credentials',
  'set-failed',
  'person-decided',
  'person-message',
  'agent-waiting',
  'turn-failed',
  'turn-skipped',
  'capacity-recovery',
  'chain-bound',
  'pane-closed',
  'setting-off',
  'not-queued',
  'round-refused',
  'evicted',
  'turn-unknown',
  'needs-you-command',
  'person-acted',
  'person-typing',
  'done',
  'no-more-improvement'
] as const satisfies readonly NextStepKeepGoingStopReason[]

const persistedEntrySchema = z.object({
  conversation: z.unknown().transform((raw) => normalizeConversationSource(raw)),
  enabled: z.boolean(),
  maxRounds: z.unknown().transform((raw) => normalizeKeepGoingRounds(raw)),
  roundsUsed: z.number().int().nonnegative(),
  startedAt: z.number().finite().nonnegative(),
  stoppedAt: z.number().finite().nonnegative().optional().catch(undefined),
  stopReason: z.enum(STOP_REASONS).optional().catch(undefined),
  stopDetail: z.string().max(1000).optional().catch(undefined),
  // Optional: an entry kept only for its ad-pause choice has never run, so it has no mode.
  mode: z.unknown().optional().transform((raw) => normalizeKeepGoingMode(raw) ?? undefined),
  pushPrompt: z
    .unknown()
    .optional()
    .transform((raw) => normalizeKeepGoingPushPrompt(raw) ?? undefined),
  stopPercent: z.number().int().min(0).max(100).optional().catch(undefined),
  adPauses: z.enum(NEXT_STEP_AD_PAUSES).optional().catch(undefined),
  lastAdPause: z
    .object({
      at: z.number().finite().nonnegative(),
      round: z.number().int().positive(),
      title: z.string().max(500)
    })
    .optional()
    .catch(undefined)
})

const persistedFileSchema = z.object({ entries: salvagingArray(persistedEntrySchema) })

function restoreEntry(
  raw: z.output<typeof persistedEntrySchema>,
  now: number
): NextStepKeepGoingState | null {
  const { conversation, maxRounds, stoppedAt, stopReason, stopDetail, stopPercent, ...fields } = raw
  if (!conversation || maxRounds === null) {
    return null
  }
  const { mode, pushPrompt, adPauses, lastAdPause, ...rest } = fields
  const run = {
    ...(mode ? { mode } : {}),
    ...(pushPrompt ? { pushPrompt } : {}),
    ...(adPauses ? { adPauses } : {}),
    ...(lastAdPause ? { lastAdPause } : {})
  }
  if (rest.enabled) {
    return {
      ...rest,
      ...run,
      conversation,
      maxRounds,
      enabled: false,
      stoppedAt: now,
      stopReason: 'restarted'
    }
  }
  return {
    ...rest,
    ...run,
    conversation,
    maxRounds,
    ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(stopDetail ? { stopDetail } : {}),
    ...(stopPercent !== undefined ? { stopPercent } : {})
  }
}

export class NextStepKeepGoingStore {
  private entries = new Map<string, NextStepKeepGoingState>()
  private writeChain: Promise<void> = Promise.resolve()
  private writeQueued = false
  private revisionValue = 0
  private readonly now: () => number
  /** Told about every entry pushed out of the file, so a running one is stopped properly. */
  onEvict: ((state: NextStepKeepGoingState) => void) | null = null

  constructor(
    private readonly options: { directory: string; now?: () => number; onChange?: () => void }
  ) {
    this.now = options.now ?? Date.now
  }

  get revision(): number {
    return this.revisionValue
  }

  private get path(): string {
    return join(this.options.directory, NEXT_STEP_KEEP_GOING_FILE)
  }

  /** Reads the saved state once at startup; anything that was on is stopped as `restarted`. */
  load(): void {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      return
    }
    const parsed = persistedFileSchema.safeParse(raw)
    const now = this.now()
    const restored = (parsed.success ? parsed.data.entries : [])
      .map((entry) => restoreEntry(entry, now))
      .filter((entry): entry is NextStepKeepGoingState => entry !== null)
    this.entries = new Map(
      restored.map((entry) => [conversationSourceRowKey(entry.conversation), entry])
    )
    // Why: rewrite at once so a second crash cannot bring an `enabled: true` back.
    if (parsed.success && parsed.data.entries.some((entry) => entry.enabled)) {
      this.persist()
    }
  }

  get(key: string): NextStepKeepGoingState | undefined {
    return this.entries.get(key)
  }

  list(): NextStepKeepGoingState[] {
    return [...this.entries.values()]
  }

  set(state: NextStepKeepGoingState): NextStepKeepGoingState {
    const key = conversationSourceRowKey(state.conversation)
    this.entries.delete(key)
    this.entries.set(key, state)
    const evicted: NextStepKeepGoingState[] = []
    // Oldest first out; a running conversation is never evicted for a stopped one.
    while (this.entries.size > NEXT_STEP_KEEP_GOING_MAX_ENTRIES) {
      const victim =
        [...this.entries].find(([, entry]) => !entry.enabled)?.[0] ??
        this.entries.keys().next().value
      if (victim === undefined) {
        break
      }
      evicted.push(this.entries.get(victim)!)
      this.entries.delete(victim)
    }
    this.persist()
    for (const entry of evicted) {
      this.onEvict?.(entry)
    }
    return state
  }

  async flush(): Promise<void> {
    await this.writeChain
  }

  private persist(): void {
    this.revisionValue++
    this.options.onChange?.()
    if (this.writeQueued) {
      return
    }
    this.writeQueued = true
    const finalPath = this.path
    this.writeChain = this.writeChain
      .then(async () => {
        this.writeQueued = false
        const payload = JSON.stringify({ version: 1, entries: [...this.entries.values()] })
        await mkdir(this.options.directory, { recursive: true })
        await writeFileDurable(durableWriteTempPath(finalPath), finalPath, payload)
      })
      .catch((error: unknown) => {
        console.error(`[next-steps] saving keep-going state to ${finalPath} failed`, error)
      })
  }
}
