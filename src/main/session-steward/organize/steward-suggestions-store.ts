/**
 * `<userData>/session-steward/suggestions.json`: what the steward proposes (merge, project,
 * couldn't place) and the person's answers. A dismissed pair is not proposed again for 30 days.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  organizationTargetKey,
  type OrganizationTarget
} from '../../../shared/session-organization-change'
import type {
  StewardSuggestion,
  StewardSuggestionKind
} from '../../../shared/session-steward-suggestions'
import { durableWriteTempPath, writeFileDurable } from '../../durable-file-write'

export const STEWARD_DIRECTORY = 'session-steward'
export const STEWARD_SUGGESTIONS_FILE = 'suggestions.json'
const DAY_MS = 24 * 60 * 60 * 1000
export const STEWARD_DISMISSED_PAIR_MS = 30 * DAY_MS
export const STEWARD_SUGGESTION_TTL_MS = 3 * DAY_MS
/** Answered suggestions stay readable this long (the dismissed pair memory is kept apart). */
const DECIDED_KEEP_MS = 7 * DAY_MS
const MAX_SUGGESTIONS = 500

type SuggestionsFile = {
  version: 1
  suggestions: StewardSuggestion[]
  /** pairKey → when it was dismissed (epoch ms). */
  dismissed: Record<string, number>
}

export type StewardSuggestionProposal = {
  kind: StewardSuggestionKind
  targets: OrganizationTarget[]
  proposal: unknown
  title: string
  evidence: string
  /** Default 3 days. */
  ttlMs?: number
  /** Default `stewardSuggestionPairKey(kind, targets)`. */
  pairKey?: string
}

/** One suggestion per kind and set of sessions, whatever order they were named in. */
export function stewardSuggestionPairKey(
  kind: StewardSuggestionKind,
  targets: readonly OrganizationTarget[]
): string {
  const keys = targets.map((target) => organizationTargetKey(target) ?? '').filter(Boolean)
  return `${kind}:${[...new Set(keys)].sort().join('|')}`
}

function isSuggestion(value: unknown): value is StewardSuggestion {
  const entry = value as Partial<StewardSuggestion> | null
  return (
    !!entry &&
    typeof entry === 'object' &&
    typeof entry.id === 'string' &&
    typeof entry.kind === 'string' &&
    typeof entry.createdAt === 'number' &&
    typeof entry.expiresAt === 'number' &&
    typeof entry.state === 'string' &&
    typeof entry.pairKey === 'string' &&
    Array.isArray(entry.targets)
  )
}

export class StewardSuggestionsStore {
  private suggestions: StewardSuggestion[] = []
  private dismissed = new Map<string, number>()
  private writes: Promise<void> = Promise.resolve()
  private loaded: Promise<void> | null = null

  constructor(
    private readonly options: {
      /** `<userData>/session-steward`. */
      directory: string
      now?: () => number
    }
  ) {}

  get path(): string {
    return join(this.options.directory, STEWARD_SUGGESTIONS_FILE)
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** Reads the file once; an unreadable file starts empty. */
  load(): Promise<void> {
    this.loaded ??= readFile(this.path, 'utf8').then(
      (text) => {
        const raw = JSON.parse(text) as Partial<SuggestionsFile>
        this.suggestions = Array.isArray(raw.suggestions)
          ? raw.suggestions.filter(isSuggestion)
          : []
        for (const [pairKey, at] of Object.entries(raw.dismissed ?? {})) {
          if (typeof at === 'number') {
            this.dismissed.set(pairKey, at)
          }
        }
      },
      () => undefined
    )
    return this.loaded
  }

  /** Open suggestions (all kinds, or one), newest first; lapsed ones turn `expired`. */
  async open(kind?: StewardSuggestionKind): Promise<StewardSuggestion[]> {
    await this.load()
    await this.expireLapsed()
    return this.suggestions
      .filter((entry) => entry.state === 'open' && (!kind || entry.kind === kind))
      .toSorted((left, right) => right.createdAt - left.createdAt)
  }

  async get(id: string): Promise<StewardSuggestion | undefined> {
    await this.load()
    await this.expireLapsed()
    return this.suggestions.find((entry) => entry.id === id)
  }

  /** The person dismissed this pair within the last 30 days: do not read it or propose it. */
  async wasDismissed(pairKey: string): Promise<boolean> {
    await this.load()
    const at = this.dismissed.get(pairKey)
    return at !== undefined && this.now() - at < STEWARD_DISMISSED_PAIR_MS
  }

  /**
   * Adds a suggestion unless its pair was dismissed in the last 30 days (null) or is already
   * open (that one is returned). A new `unplaced` list replaces the previous open one.
   */
  async propose(input: StewardSuggestionProposal): Promise<StewardSuggestion | null> {
    await this.load()
    await this.expireLapsed()
    const pairKey = input.pairKey ?? stewardSuggestionPairKey(input.kind, input.targets)
    if (await this.wasDismissed(pairKey)) {
      return null
    }
    const existing = this.suggestions.find(
      (entry) => entry.state === 'open' && entry.pairKey === pairKey
    )
    if (existing) {
      return existing
    }
    const now = this.now()
    const suggestion: StewardSuggestion = {
      id: `sg-${randomUUID()}`,
      kind: input.kind,
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? STEWARD_SUGGESTION_TTL_MS),
      targets: input.targets,
      proposal: input.proposal,
      title: input.title,
      evidence: input.evidence,
      state: 'open',
      pairKey
    }
    this.suggestions = [
      ...this.suggestions.map((entry) =>
        input.kind === 'unplaced' && entry.kind === 'unplaced' && entry.state === 'open'
          ? { ...entry, state: 'expired' as const, decidedAt: now }
          : entry
      ),
      suggestion
    ]
    await this.persist()
    return suggestion
  }

  /** Dismissed by the person: its pair is remembered for 30 days. */
  async dismiss(id: string): Promise<StewardSuggestion> {
    const suggestion = await this.requireOpen(id)
    const now = this.now()
    this.dismissed.set(suggestion.pairKey, now)
    return this.replace({ ...suggestion, state: 'dismissed', decidedAt: now })
  }

  /** The accepted action finished; `outcome` is what it reported. */
  async markAccepted(id: string, outcome: string): Promise<StewardSuggestion> {
    const suggestion = await this.requireOpen(id)
    return this.replace({ ...suggestion, state: 'accepted', decidedAt: this.now(), outcome })
  }

  /** An open, unexpired suggestion, or a plain refusal naming what happened to it. */
  async requireOpen(id: string): Promise<StewardSuggestion> {
    const suggestion = await this.get(id)
    if (!suggestion) {
      throw new Error(`No steward suggestion ${id}.`)
    }
    if (suggestion.state !== 'open') {
      throw new Error(`That suggestion was already ${suggestion.state}. Nothing changed.`)
    }
    return suggestion
  }

  async flush(): Promise<void> {
    await this.writes
  }

  private async replace(next: StewardSuggestion): Promise<StewardSuggestion> {
    this.suggestions = this.suggestions.map((entry) => (entry.id === next.id ? next : entry))
    await this.persist()
    return next
  }

  private async expireLapsed(): Promise<void> {
    const now = this.now()
    let changed = false
    this.suggestions = this.suggestions.map((entry) => {
      if (entry.state !== 'open' || entry.expiresAt > now) {
        return entry
      }
      changed = true
      return { ...entry, state: 'expired', decidedAt: now }
    })
    if (changed) {
      // Why swallowed: a read must not fail because the expiry could not be saved yet.
      await this.persist().catch((error: unknown) => {
        console.warn('[session-steward] saving expired suggestions failed', error)
      })
    }
  }

  private persist(): Promise<void> {
    const now = this.now()
    for (const [pairKey, at] of this.dismissed) {
      if (now - at >= STEWARD_DISMISSED_PAIR_MS) {
        this.dismissed.delete(pairKey)
      }
    }
    this.suggestions = this.suggestions
      .filter((entry) => entry.state === 'open' || now - (entry.decidedAt ?? now) < DECIDED_KEEP_MS)
      .slice(-MAX_SUGGESTIONS)
    const file: SuggestionsFile = {
      version: 1,
      suggestions: this.suggestions,
      dismissed: Object.fromEntries(this.dismissed)
    }
    const payload = JSON.stringify(file, null, 2)
    // Serialized so an older snapshot never lands after a newer one.
    const write = this.writes.then(async () => {
      await mkdir(this.options.directory, { recursive: true })
      await writeFileDurable(durableWriteTempPath(this.path), this.path, payload)
    })
    this.writes = write.catch(() => {})
    return write
  }
}

const stores = new Map<string, StewardSuggestionsStore>()

/** One store per profile directory. */
export function stewardSuggestionsFor(userDataPath: string): StewardSuggestionsStore {
  let store = stores.get(userDataPath)
  if (!store) {
    store = new StewardSuggestionsStore({ directory: join(userDataPath, STEWARD_DIRECTORY) })
    stores.set(userDataPath, store)
  }
  return store
}
