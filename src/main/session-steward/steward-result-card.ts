/**
 * The result card a Tier 2 archive leaves behind, built without any model: the end of the last
 * reply, the pull requests it named, the files changed in its workspace, its outcome receipts and
 * the links it produced. Saved to `<userData>/session-steward/results/` before the archive is
 * relayed, so "Finished since you last looked" can show it after any restart.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionLinkedDoc } from '../../shared/session-linked-docs'
import { sessionLinksInText } from '../../shared/session-links'
import type { SessionPullRequestFacts } from '../../shared/session-pull-request-facts'
import type {
  StewardResultCard,
  StewardResultPullRequest,
  StewardResultReceipt
} from '../../shared/session-steward-status'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'
import { STEWARD_DIRECTORY } from './steward-state-store'

export const STEWARD_RESULTS_DIRECTORY = 'results'
export const STEWARD_RESULT_REPLY_MAX = 4_000
const MAX_FILES = 200
const MAX_RECEIPTS = 50
const MAX_LINKS = 30
const MAX_CARDS = 500
const TEXT_MAX = 500

export type StewardResultCardInput = {
  key: string
  paneKey: string
  title: string
  goal: string | null
  reply: string | null
  changed: { files: string[]; branch: string | null } | null
  /** The chains this conversation ran (its own), for their receipts. */
  chains: readonly SessionChain[]
  linkedDocs: readonly SessionLinkedDoc[]
  pullRequestFacts?: readonly SessionPullRequestFacts[]
  summary?: string | null
  /** The finished turn the card describes. */
  turnKey?: string
  evidence: string
  now: number
}

function tail(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `…${trimmed.slice(trimmed.length - max)}` : trimmed
}

function receiptsOf(chains: readonly SessionChain[]): StewardResultReceipt[] {
  return chains
    .flatMap((chain) => chain.outcomeSet?.outcomes ?? [])
    .flatMap((outcome) => outcome.evidence)
    .map((evidence) => ({
      kind: evidence.kind,
      target: evidence.target.slice(0, TEXT_MAX),
      receipt: evidence.receipt.slice(0, TEXT_MAX),
      verifiedAt: evidence.verifiedAt
    }))
    .slice(-MAX_RECEIPTS)
}

function pullRequestsOf(
  reply: string,
  facts: readonly SessionPullRequestFacts[]
): StewardResultPullRequest[] {
  const byKey = new Map<string, StewardResultPullRequest>()
  for (const link of sessionLinksInText(reply)) {
    const ref = link.pullRequest
    if (ref) {
      byKey.set(`${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase(), { ...ref, url: link.url })
    }
  }
  for (const fact of facts) {
    const key = `${fact.owner}/${fact.repo}#${fact.number}`.toLowerCase()
    byKey.set(key, {
      owner: fact.owner,
      repo: fact.repo,
      number: fact.number,
      url: fact.url,
      title: fact.title.slice(0, TEXT_MAX),
      state: fact.state
    })
  }
  return [...byKey.values()].slice(0, MAX_LINKS)
}

export function buildStewardResultCard(input: StewardResultCardInput): StewardResultCard {
  const reply = input.reply ?? ''
  const linked = input.linkedDocs.map((doc) => ({ url: doc.url, kind: doc.kind }))
  const produced = sessionLinksInText(reply)
    .filter((link) => link.kind !== 'pull-request')
    .map((link) => ({ url: link.url, kind: link.kind }))
  const artifacts = [...new Map([...linked, ...produced].map((link) => [link.url, link])).values()]
  const summary = input.summary?.trim()
  return {
    key: input.key,
    paneKey: input.paneKey,
    title: input.title,
    goal: input.goal ? tail(input.goal, TEXT_MAX * 4) : null,
    lastReply: tail(reply, STEWARD_RESULT_REPLY_MAX),
    pullRequests: pullRequestsOf(reply, input.pullRequestFacts ?? []),
    changedFiles: (input.changed?.files ?? []).slice(0, MAX_FILES),
    branch: input.changed?.branch ?? null,
    outcomeReceipts: receiptsOf(input.chains),
    artifacts: artifacts.slice(0, MAX_LINKS),
    ...(summary ? { summary: tail(summary, STEWARD_RESULT_REPLY_MAX) } : {}),
    ...(input.turnKey ? { turnKey: input.turnKey } : {}),
    evidence: input.evidence,
    builtAt: input.now
  }
}

function parseCard(raw: unknown): StewardResultCard | null {
  const card = raw as Partial<StewardResultCard> | null
  return card &&
    typeof card.key === 'string' &&
    typeof card.paneKey === 'string' &&
    typeof card.title === 'string' &&
    typeof card.lastReply === 'string' &&
    typeof card.builtAt === 'number' &&
    Array.isArray(card.pullRequests) &&
    Array.isArray(card.changedFiles) &&
    Array.isArray(card.outcomeReceipts) &&
    Array.isArray(card.artifacts)
    ? (card as StewardResultCard)
    : null
}

/** What a waiter's wait reads of a card (WP-S3's `installSessionResultCardReader`). */
export type StewardCardReading = { revision: string; at: number; summary?: string }

/** One file per archive key; saving again (a later archive of the same session) replaces it. */
export class StewardResultCardStore {
  /** Newest card per pane, filled on first use and kept current by `save`. */
  private byPane: Map<string, StewardResultCard> | null = null

  constructor(private readonly userDataPath: string) {}

  get directory(): string {
    return join(this.userDataPath, STEWARD_DIRECTORY, STEWARD_RESULTS_DIRECTORY)
  }

  private pathFor(key: string): string {
    const name = createHash('sha256').update(key).digest('hex').slice(0, 40)
    return join(this.directory, `${name}.json`)
  }

  async save(card: StewardResultCard): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const path = this.pathFor(card.key)
    await writeFileDurable(durableWriteTempPath(path), path, JSON.stringify(card))
    this.byPane?.set(card.paneKey, card)
  }

  /** The result a session waiting on `paneKey` reads: which card (its turn) and when. */
  readingForPane(paneKey: string): StewardCardReading | null {
    this.byPane ??= new Map(
      this.list()
        .toReversed()
        .map((card) => [card.paneKey, card])
    )
    const card = this.byPane.get(paneKey)
    return card
      ? {
          revision: `${card.key}|${card.turnKey ?? card.builtAt}`,
          at: card.builtAt,
          summary: card.summary ?? card.lastReply
        }
      : null
  }

  read(key: string): StewardResultCard | null {
    try {
      return parseCard(JSON.parse(readFileSync(this.pathFor(key), 'utf8')))
    } catch {
      return null
    }
  }

  /** Newest first; beyond `MAX_CARDS` the oldest are removed. */
  list(): StewardResultCard[] {
    let names: string[]
    try {
      names = readdirSync(this.directory).filter((name) => name.endsWith('.json'))
    } catch {
      return []
    }
    const cards = names
      .map((name) => {
        try {
          return parseCard(JSON.parse(readFileSync(join(this.directory, name), 'utf8')))
        } catch {
          return null
        }
      })
      .filter((card): card is StewardResultCard => card !== null)
      .toSorted((left, right) => right.builtAt - left.builtAt)
    for (const stale of cards.slice(MAX_CARDS)) {
      void rm(this.pathFor(stale.key), { force: true }).catch(() => {})
    }
    return cards.slice(0, MAX_CARDS)
  }
}
