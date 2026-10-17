/**
 * Suggested-next-step sets and the decision log, on this host's own disk.
 *
 * `next-step-suggestions.json` holds the recent sets (at most 200, none older than 7 days), so a
 * restart shows the same tray. `next-step-decisions.jsonl` is append-only, one decision per line,
 * rotated once it passes ~5 MB; it is what later tunes the suggester.
 */

import { readFileSync } from 'node:fs'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { normalizeConversationSource } from '../../shared/conversation-source'
import type { NextStepKeepGoingStopRecord } from '../../shared/next-step-keep-going'
import {
  hasUniqueNextStepIds,
  NEXT_STEP_OPTION_GROUP_MAX,
  type NextStepDecisionRecord,
  type NextStepSuggestionSet
} from '../../shared/next-step-suggestions'
import {
  offeredSuggestionSchema,
  toNextStepSuggestions
} from '../../shared/next-step-suggestion-output'
import { collectSalvageDrops, salvagingArray } from '../../shared/zod-salvage'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'

export const NEXT_STEP_SETS_FILE = 'next-step-suggestions.json'
export const NEXT_STEP_DECISIONS_FILE = 'next-step-decisions.jsonl'
export const NEXT_STEP_MAX_SETS = 200
export const NEXT_STEP_SET_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const NEXT_STEP_DECISION_LOG_ROTATE_BYTES = 5 * 1024 * 1024
/** A decision log line: the contract record plus, for a run, what could not be queued. */
export type NextStepLoggedDecision = NextStepDecisionRecord & {
  notQueued?: { id: string; reason: string }[]
  /** Relayed by another session the person asked (its pane key, or `cli`). */
  via?: string
}

export const NEXT_STEP_INTERRUPTED_REASON =
  'OmniConsole closed while these suggestions were being written. Ask for suggestions again.'

const STATUSES = ['generating', 'pending', 'accepted', 'dismissed', 'superseded', 'failed'] as const
const ORIGINS = ['parsed', 'ai', 'start'] as const

const persistedSetSchema = z.object({
  id: z.string().min(1).max(200),
  conversation: z.unknown().transform((raw) => normalizeConversationSource(raw) ?? undefined),
  worktreeId: z.string().min(1),
  turnKey: z.string().min(1).max(1000),
  origin: z.enum(ORIGINS),
  createdAt: z.number().finite().nonnegative(),
  status: z.enum(STATUSES),
  suggestions: salvagingArray(
    offeredSuggestionSchema.extend({
      id: z.string().min(1).max(64),
      riskReason: z.literal('jev').optional().catch(undefined),
      jevRisk: z.number().min(0).max(1).optional().catch(undefined),
      offered: z.literal(true).optional().catch(undefined),
      preselected: z.literal(true).optional().catch(undefined),
      optionGroup: z.string().min(1).max(NEXT_STEP_OPTION_GROUP_MAX).optional().catch(undefined)
    })
  ),
  model: z.string().max(200).optional().catch(undefined),
  error: z.string().max(1000).optional().catch(undefined),
  messageId: z.string().max(1000).optional().catch(undefined),
  rankedBy: z.enum(['jev', 'model']).optional().catch(undefined),
  jevScores: z.record(z.string(), z.number().min(0).max(1)).optional().catch(undefined)
})

const persistedFileSchema = z.object({ sets: salvagingArray(persistedSetSchema) })

type PersistedSet = z.output<typeof persistedSetSchema>

function restoreSet(raw: PersistedSet): NextStepSuggestionSet {
  const { conversation, model, error, messageId, suggestions, rankedBy, jevScores, ...rest } = raw
  const interrupted = raw.status === 'generating'
  return {
    ...rest,
    ...(conversation ? { conversation } : {}),
    // The risk floor is re-applied; JEV's marks ride along by position (the mapping is 1:1 and
    // renames duplicate ids), and its raise survives: a restart never turns a flagged step safe.
    suggestions: toNextStepSuggestions(suggestions, { keepIds: true }).map((step, index) => {
      const { riskReason, jevRisk, offered, preselected, optionGroup } = suggestions[index]!
      return {
        ...step,
        ...(riskReason === 'jev' ? { risk: 'risky' as const, riskReason } : {}),
        ...(jevRisk !== undefined ? { jevRisk } : {}),
        ...(offered ? { offered } : {}),
        ...(preselected ? { preselected } : {}),
        ...(optionGroup ? { optionGroup } : {})
      }
    }),
    ...(rankedBy ? { rankedBy } : {}),
    ...(jevScores ? { jevScores } : {}),
    ...(model ? { model } : {}),
    ...(messageId ? { messageId } : {}),
    ...(interrupted ? { status: 'failed' as const, error: NEXT_STEP_INTERRUPTED_REASON } : {}),
    ...(!interrupted && error ? { error } : {})
  }
}

export type NextStepSuggestionStoreOptions = {
  directory: string
  now?: () => number
  onChange?: () => void
}

export class NextStepSuggestionStore {
  private sets: NextStepSuggestionSet[] = []
  private writeChain: Promise<void> = Promise.resolve()
  private logChain: Promise<void> = Promise.resolve()
  private writeQueued = false
  private persistError: string | undefined
  private revisionValue = 0
  private readonly now: () => number

  constructor(private readonly options: NextStepSuggestionStoreOptions) {
    this.now = options.now ?? Date.now
  }

  get revision(): number {
    return this.revisionValue
  }

  private get setsPath(): string {
    return join(this.options.directory, NEXT_STEP_SETS_FILE)
  }

  private get logPath(): string {
    return join(this.options.directory, NEXT_STEP_DECISIONS_FILE)
  }

  /** Reads the saved sets once at startup; an unreadable file starts empty rather than failing. */
  load(): void {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.setsPath, 'utf8'))
    } catch {
      this.sets = []
      return
    }
    const { value, droppedCount } = collectSalvageDrops(() => persistedFileSchema.safeParse(raw))
    if (droppedCount) {
      console.warn(`[next-steps] dropped ${droppedCount} unreadable saved suggestion rows`)
    }
    const read = value.success ? value.data.sets : []
    // A saved set whose ids repeat is dropped, never repaired into a different meaning.
    const saved = read.filter((set) => hasUniqueNextStepIds(set))
    if (saved.length < read.length) {
      console.warn(
        `[next-steps] dropped ${read.length - saved.length} saved sets with repeated ids`
      )
    }
    this.sets = this.prune(saved.map(restoreSet))
    // Why: rewrite at once so a second crash cannot resurrect the interrupted sets as generating.
    if (saved.some((set) => set.status === 'generating')) {
      this.persist()
    }
  }

  list(): NextStepSuggestionSet[] {
    return [...this.sets].sort((left, right) => right.createdAt - left.createdAt)
  }

  get(setId: string): NextStepSuggestionSet | undefined {
    return this.sets.find((set) => set.id === setId)
  }

  upsert(set: NextStepSuggestionSet): NextStepSuggestionSet {
    const index = this.sets.findIndex((entry) => entry.id === set.id)
    const next =
      index === -1
        ? [...this.sets, set]
        : this.sets.map((entry, at) => (at === index ? set : entry))
    this.sets = this.prune(next)
    this.persist()
    return set
  }

  update(
    setId: string,
    change: (set: NextStepSuggestionSet) => NextStepSuggestionSet
  ): NextStepSuggestionSet | undefined {
    const current = this.get(setId)
    return current ? this.upsert(change(current)) : undefined
  }

  remove(setId: string): void {
    const next = this.sets.filter((set) => set.id !== setId)
    if (next.length !== this.sets.length) {
      this.sets = next
      this.persist()
    }
  }

  /** Rejects when the line could not be written; later appends still run. */
  appendDecision(record: NextStepLoggedDecision): Promise<void> {
    return this.appendRecord(record, `the decision for set ${record.setId}`)
  }

  /** A "Keep going" stop, beside the decisions it ended; rejects like `appendDecision`. */
  appendKeepGoingStop(record: NextStepKeepGoingStopRecord): Promise<void> {
    return this.appendRecord(record, `a keep-going stop (${record.reason})`)
  }

  /** The last failure to save the sets, until a later save succeeds. */
  get storageError(): string | undefined {
    return this.persistError
  }

  /** Settles every write already started; for quit and tests. */
  async flush(): Promise<void> {
    await Promise.all([this.writeChain, this.logChain])
  }

  private prune(sets: NextStepSuggestionSet[]): NextStepSuggestionSet[] {
    const oldest = this.now() - NEXT_STEP_SET_MAX_AGE_MS
    return sets
      .filter((set) => set.createdAt >= oldest)
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(-NEXT_STEP_MAX_SETS)
  }

  private persist(): void {
    this.revisionValue++
    this.options.onChange?.()
    // Coalesced: a burst of changes writes the newest state once, not every step of it.
    if (this.writeQueued) {
      return
    }
    this.writeQueued = true
    const finalPath = this.setsPath
    this.writeChain = this.writeChain
      .then(async () => {
        this.writeQueued = false
        const payload = JSON.stringify({ version: 1, sets: this.sets })
        await mkdir(this.options.directory, { recursive: true })
        await writeFileDurable(durableWriteTempPath(finalPath), finalPath, payload)
      })
      .then(
        () => {
          this.persistError = undefined
        },
        (error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error)
          this.persistError = `Suggestions could not be saved: ${detail}`
          console.error(
            `[next-steps] saving ${this.sets.length} suggestion sets to ${finalPath} failed`,
            error
          )
        }
      )
  }

  private appendRecord(record: object, label: string): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    const write = this.logChain.then(() => this.appendLine(line))
    this.logChain = write.catch(() => {})
    return write.catch((error: unknown) => {
      console.error(`[next-steps] appending ${label} to ${this.logPath} failed`, error)
      throw error
    })
  }

  private async appendLine(line: string): Promise<void> {
    await mkdir(this.options.directory, { recursive: true })
    const size = await stat(this.logPath).then(
      (info) => info.size,
      () => 0
    )
    if (size + line.length > NEXT_STEP_DECISION_LOG_ROTATE_BYTES && size > 0) {
      await rename(this.logPath, `${this.logPath}.1`)
    }
    await appendFile(this.logPath, line, 'utf8')
  }
}
