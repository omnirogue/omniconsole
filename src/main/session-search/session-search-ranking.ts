import type { SessionSearchMatch, SessionSearchSnippet } from '../../shared/session-search-types'
import { cosineSimilarity, type StaticEmbeddingModel } from './session-search-embedding'
import type { SessionRow, SessionSearchIndex } from './session-search-index'
import { isSidecarAsk } from './session-search-facts'
import {
  allGroupsExpression,
  anyGroupExpression,
  groupMatchExpression,
  proximityExpression,
  type SessionSearchPlan,
  type SessionSearchTermGroup
} from './session-search-query'

export type RankedSession = {
  session: SessionRow
  score: number
  match: SessionSearchMatch
  reasons: string[]
  snippets: SessionSearchSnippet[]
}

export type RankOptions = {
  limit: number
  now: number
  model: StaticEmbeddingModel | null
  embeddings: ReadonlyMap<number, Float32Array>
  queryText: string
}

/** Below this a summary is not about the same thing; measured on real summaries. */
const SEMANTIC_FLOOR = 0.42
const SEMANTIC_CANDIDATES = 40
const RECENCY_HALF_LIFE_DAYS = 14
// Session-level BM25: a session is the document and its chunk count is the length, so a
// 30 MB transcript cannot outrank a focused one merely by mentioning everything more often.
const BM25_K1 = 1.2
const BM25_B = 0.5

function saturate(count: number, length: number, averageLength: number): number {
  if (count <= 0) {
    return 0
  }
  // Why the floor: a one-line probe session must not outrank real work for a single mention.
  const norm = 1 - BM25_B + (BM25_B * Math.max(length, averageLength / 4)) / averageLength
  return (count * (BM25_K1 + 1)) / (count + BM25_K1 * norm)
}

type Evidence = {
  counts: number[]
  near: number
  inTitle: boolean
  inSummary: boolean
  semantic: number
}

function termLabel(group: SessionSearchTermGroup): string {
  const typed = `“${group.label}”`
  return group.expansions.length > 0 ? `${typed} (or ${group.expansions.join(', ')})` : typed
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function reasonsFor(plan: SessionSearchPlan, evidence: Evidence): string[] {
  const reasons: string[] = []
  plan.groups.forEach((group, index) => {
    const count = evidence.counts[index] ?? 0
    if (count > 0) {
      reasons.push(`${termLabel(group)} in ${plural(count, 'message')}`)
    }
  })
  if (evidence.near > 0 && plan.groups.length > 1) {
    const together = plan.groups.map((group) => `“${group.label}”`).join(' + ')
    reasons.unshift(`${together} together in ${plural(evidence.near, 'message')}`)
  }
  if (evidence.inTitle) {
    reasons.push('title matches')
  } else if (evidence.inSummary) {
    reasons.push('summary matches')
  }
  if (evidence.semantic >= SEMANTIC_FLOOR) {
    reasons.push(`summary is about a similar topic (${evidence.semantic.toFixed(2)})`)
  }
  return reasons
}

function matchOf(evidence: Evidence): SessionSearchMatch {
  if (evidence.inTitle) {
    return 'title'
  }
  return evidence.inSummary || evidence.counts.some((count) => count > 0) ? 'text' : 'meaning'
}

function semanticCandidates(options: RankOptions): Map<number, number> {
  const out = new Map<number, number>()
  if (!options.model || options.embeddings.size === 0) {
    return out
  }
  const query = options.model.embed(options.queryText)
  const scored: [number, number][] = []
  for (const [sid, vector] of options.embeddings) {
    const similarity = cosineSimilarity(query, vector)
    if (similarity >= SEMANTIC_FLOOR) {
      scored.push([sid, similarity])
    }
  }
  scored.sort((a, b) => b[1] - a[1])
  for (const [sid, similarity] of scored.slice(0, SEMANTIC_CANDIDATES)) {
    out.set(sid, similarity)
  }
  return out
}

/** Rank sessions for a planned query; transcript text never leaves this process. */
export function rankSessions(
  index: SessionSearchIndex,
  plan: SessionSearchPlan,
  options: RankOptions
): RankedSession[] {
  if (plan.groups.length === 0) {
    return []
  }
  const lengths = index.sessionLengths()
  const total = Math.max(1, lengths.size)
  let lengthSum = 0
  for (const length of lengths.values()) {
    lengthSum += length
  }
  const averageLength = Math.max(1, lengthSum / total)
  const countsFor = (expression: string | null): Map<number, number> =>
    new Map(expression ? index.termCounts(expression).map((row) => [row.sid, row.count]) : [])
  const perGroup = plan.groups.map((group) => countsFor(groupMatchExpression(group)))
  const idf = perGroup.map((counts) => Math.log(1 + total / Math.max(1, counts.size)))
  const near = countsFor(proximityExpression(plan))
  const nearIdf = Math.log(1 + total / Math.max(1, near.size))
  const anyExpression = anyGroupExpression(plan)
  const allExpression = allGroupsExpression(plan)
  const titles = index.docMatches(allExpression, 'title')
  const summaries = index.docMatches(allExpression, 'summary')
  const candidates = new Set<number>([...titles, ...summaries])
  for (const counts of perGroup) {
    for (const sid of counts.keys()) {
      candidates.add(sid)
    }
  }
  // Why: a URL or an ID asks for exact text; meaning only helps when words were typed.
  const semantic = plan.groups.some((group) => group.kind === 'word')
    ? semanticCandidates(options)
    : new Map<number, number>()
  // Meaning-only hits fill a short list; they never push out sessions that contain the words.
  const lexicalCount = candidates.size
  for (const sid of semantic.keys()) {
    if (lexicalCount < options.limit) {
      candidates.add(sid)
    }
  }
  for (const sid of index.sidecarSids()) {
    candidates.delete(sid)
  }
  const evidence = new Map<number, Evidence>()
  const scores: [number, number][] = []
  for (const sid of candidates) {
    const length = lengths.get(sid) ?? 1
    const counts = perGroup.map((groupCounts) => groupCounts.get(sid) ?? 0)
    const matched = counts.filter((count) => count > 0).length
    const inTitle = titles.has(sid)
    const inSummary = summaries.has(sid)
    const similarity = semantic.get(sid) ?? 0
    const together = near.get(sid) ?? 0
    const content =
      counts.reduce((sum, count, i) => sum + saturate(count, length, averageLength) * idf[i]!, 0) +
      2 * saturate(together, length, averageLength) * nearIdf
    const docScore = (inTitle ? 4 : 0) + (inSummary ? 2 : 0)
    const coverage = inTitle || inSummary ? 1 : matched / plan.groups.length
    const lexical = coverage * coverage * (content + docScore)
    const meaning = similarity >= SEMANTIC_FLOOR ? 6 * (similarity - SEMANTIC_FLOOR + 0.1) : 0
    evidence.set(sid, { counts, near: together, inTitle, inSummary, semantic: similarity })
    scores.push([sid, lexical + meaning])
  }
  scores.sort((a, b) => b[1] - a[1])
  // Recency only reorders near-ties, so rank a generous head before applying it.
  const head = scores.slice(0, Math.max(options.limit * 4, 40))
  const sessions = index.sessionsBySid(head.map(([sid]) => sid))
  const ranked: RankedSession[] = []
  for (const [sid, base] of head) {
    const session = sessions.get(sid)
    // Why the ask too: a helper run indexed before its prompt was listed here is still 'work'.
    if (!session || isSidecarAsk(session.firstAsk ?? '')) {
      continue
    }
    const ageDays = session.lastTs ? Math.max(0, options.now - session.lastTs) / 86_400_000 : 365
    const recency = 1.5 * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS)
    const found = evidence.get(sid)!
    ranked.push({
      session,
      score: base + recency,
      match: matchOf(found),
      reasons: reasonsFor(plan, found),
      snippets: []
    })
  }
  ranked.sort((a, b) => b.score - a.score)
  const top = ranked.slice(0, options.limit)
  for (const entry of top) {
    entry.snippets = index.snippets(entry.session.sid, anyExpression, 2)
  }
  return top
}
