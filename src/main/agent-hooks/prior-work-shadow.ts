// Prior-work pointer, SHADOW ONLY (Intelligence 10x W2-A8, approved by Sal on 10 Oct 2026). At a
// session's first prompt it ranks the 1-3 most relevant earlier sessions and ~/Work/Ops/Projects
// folders from local sources and appends them to a log in the app's logs directory. It injects
// nothing: every prompt still reaches the agent as typed (Sal, 2026-09-24). Kill switch:
// OMNI_PRIOR_WORK_SHADOW_DISABLED=1 at launch, or a `prior-work-shadow.off` file in the logs directory.

import { createHash } from 'node:crypto'
import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { isNewTurnEvent } from '../../shared/agent-hook-listener/provider-event-routing'
import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
import { submittedHookPromptText } from '../../shared/submitted-hook-prompt'
import { prefixStem, searchTokens } from '../session-search/session-search-query'
import type { SessionSearchService } from '../session-search/session-search-service'
import { createAsyncLocalFileSink } from '../observability/async-local-file-sink'

export const PRIOR_WORK_SHADOW_BUDGET_MS = 300
export const PRIOR_WORK_SHADOW_LOG_FILE = 'prior-work-shadow.ndjson'
export const PRIOR_WORK_SHADOW_OFF_FILE = 'prior-work-shadow.off'
export const PRIOR_WORK_SHADOW_DISABLED_ENV = 'OMNI_PRIOR_WORK_SHADOW_DISABLED'
const MAX_CANDIDATES = 3
// Why 4: on the census pairs 4 words found the earlier twin more often than 8, and searched faster.
const MAX_QUERY_TERMS = 4
const SESSION_HIT_LIMIT = 6
const PROMPT_SCAN_CHARS = 2_000
const FOLDER_LIST_TTL_MS = 60_000
const MAX_TRACKED_SESSIONS = 2_000

// The census stop list (Intelligence-10x metrics/dupes.py, words of 3+ letters), so the query keeps topic words.
const STOP_WORDS = new Set(
  `the and you are our this that does did can could should would will from not what which how why
  when where there their them they any all please also just like make need want get have has was were
  been one two new then than more most about into out only its dont let know see find check use using
  via per etc`.split(/\s+/)
)

export type PriorWorkCandidate = {
  kind: 'session' | 'folder'
  /** `<agent>:<sessionId>` for a session, the absolute path for a folder. */
  ref: string
  title: string
  /** The source's own score: session-search relevance, or the matched share of a folder's words. */
  score: number
}

type SourceState = 'ok' | 'timeout' | 'busy' | 'unavailable' | 'failed'
type SourceResult = { state: SourceState; candidates: PriorWorkCandidate[] }

export type PriorWorkShadowRecord = {
  at: number
  session_id: string | null
  prompt_sha16: string
  candidates: PriorWorkCandidate[]
  latency_ms: number
  agent: AgentHookSource
  /** No OmniOS page titles are cached on this host, so `pages` is always 'none'. */
  sources: { sessions: SourceState; folders: SourceState; pages: 'none' }
}

export type PriorWorkShadowDeps = {
  logsDirectory: string
  projectsDirectory: string
  sessionSearch: () => Pick<SessionSearchService, 'state' | 'search'> | null
  sink?: { push(record: unknown): void }
  /** Monotonic milliseconds. */
  now?: () => number
}

type ShadowInput = {
  source: AgentHookSource
  sessionId: string | null
  prompt: string
  at: number
  arrivedAt: number
}

function topicTokens(text: string): string[] {
  return searchTokens(text).filter(
    (token) => token.length >= 3 && !/^\d+$/.test(token) && !STOP_WORDS.has(token)
  )
}

/** The first distinct topic words of the prompt: the session-search query (eval parity: metrics/prior_work_eval.py). */
export function priorWorkQueryTerms(prompt: string): string[] {
  return [...new Set(topicTokens(prompt.slice(0, PROMPT_SCAN_CHARS)))].slice(0, MAX_QUERY_TERMS)
}

/** Folders sharing at least two words with the prompt, or all of their words; best share first. */
export function rankProjectFolders(
  names: string[],
  prompt: string
): { name: string; score: number }[] {
  const promptStems = new Set(topicTokens(prompt.slice(0, PROMPT_SCAN_CHARS)).map(prefixStem))
  const ranked: { name: string; score: number }[] = []
  for (const name of names) {
    // Why the split: `PromptHook-Shadow` and `prompt-hook-shadow` should read the same.
    const words = [
      ...new Set(topicTokens(name.replace(/([a-z])([A-Z])/g, '$1 $2')).map(prefixStem))
    ]
    const matched = words.filter((word) => promptStems.has(word)).length
    if (matched >= 2 || (matched >= 1 && matched === words.length)) {
      ranked.push({ name, score: matched / words.length })
    }
  }
  // Why code-point order on a tie: the eval's Python port sorts the same way.
  return ranked.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1))
}

/** Sessions in search order, then folders fill what is left (folders found no census twin; eval W2-A8). */
export function mergePriorWorkCandidates(
  sessions: PriorWorkCandidate[],
  folders: PriorWorkCandidate[]
): PriorWorkCandidate[] {
  return [...sessions, ...folders]
    .slice(0, MAX_CANDIDATES)
    .map((candidate) => ({ ...candidate, score: Math.round(candidate.score * 1000) / 1000 }))
}

function withinBudget(work: Promise<SourceResult>, ms: number): Promise<SourceResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ state: 'timeout', candidates: [] }), ms)
    timer.unref?.()
    work.then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      () => {
        clearTimeout(timer)
        resolve({ state: 'failed', candidates: [] })
      }
    )
  })
}

function isSessionStart(hookEventName: string | undefined): boolean {
  return hookEventName?.replaceAll('_', '').toLowerCase() === 'sessionstart'
}

export class PriorWorkShadow {
  private readonly seenSessions = new Set<string>()
  private readonly resumedPanes = new Set<string>()
  private folderList: { at: number; names: Promise<string[] | null> } | null = null
  private searchInFlight = false
  private readonly sink: { push(record: unknown): void }
  private readonly now: () => number

  constructor(private readonly deps: PriorWorkShadowDeps) {
    this.now = deps.now ?? (() => performance.now())
    this.sink =
      deps.sink ??
      createAsyncLocalFileSink({
        filePath: join(deps.logsDirectory, PRIOR_WORK_SHADOW_LOG_FILE),
        maxBytes: 5 * 1024 * 1024,
        maxFiles: 3,
        warnLabel: 'prior-work-shadow'
      })
  }

  /** Every accepted hook event passes here. Returns at once; the hook reply never depends on it. */
  observe(source: AgentHookSource, event: AgentHookEventPayload, body: unknown): void {
    try {
      this.observeEvent(source, event, body)
    } catch (error) {
      console.warn('[prior-work-shadow] observe failed', error)
    }
  }

  private observeEvent(source: AgentHookSource, event: AgentHookEventPayload, body: unknown): void {
    if (event.isReplay || event.toolAgentId) {
      return
    }
    if (isSessionStart(event.hookEventName)) {
      if (event.sessionStartSource === 'resume') {
        this.resumedPanes.add(event.paneKey)
      } else if (event.sessionStartSource) {
        this.resumedPanes.delete(event.paneKey)
      }
      return
    }
    if (!event.hasExplicitPrompt || !isNewTurnEvent(source, event.hookEventName)) {
      return
    }
    const sessionId = event.providerSession?.id ?? null
    const key = sessionId ? `${source}:${sessionId}` : `${event.paneKey}|${event.launchToken ?? ''}`
    if (this.seenSessions.has(key)) {
      return
    }
    // Why before marking seen: a harness turn (task notification, reminder) is not the person's first ask.
    const prompt = (submittedHookPromptText(body) ?? event.payload.prompt).trim()
    if (!prompt || isKnownHarnessInjectedUserTurnText(prompt)) {
      return
    }
    this.seenSessions.add(key)
    if (this.seenSessions.size > MAX_TRACKED_SESSIONS) {
      this.seenSessions.delete(this.seenSessions.values().next().value!)
    }
    // Why: a resumed conversation's first prompt in this pane is a follow-up, not the session's first ask.
    if (this.resumedPanes.has(event.paneKey)) {
      return
    }
    const input = { source, sessionId, prompt, at: Date.now(), arrivedAt: this.now() }
    // Why setImmediate: nothing below runs before the hook's reply is written.
    setImmediate(() => {
      this.run(input).catch((error) => console.warn('[prior-work-shadow] run failed', error))
    })
  }

  private async run(input: ShadowInput): Promise<void> {
    if (await this.isOff()) {
      return
    }
    const remaining = Math.max(0, PRIOR_WORK_SHADOW_BUDGET_MS - (this.now() - input.arrivedAt))
    const [sessions, folders] = await Promise.all([
      withinBudget(this.sessionCandidates(input), remaining),
      withinBudget(this.folderCandidates(input.prompt), remaining)
    ])
    const record: PriorWorkShadowRecord = {
      at: input.at,
      session_id: input.sessionId,
      prompt_sha16: createHash('sha256').update(input.prompt).digest('hex').slice(0, 16),
      candidates: mergePriorWorkCandidates(sessions.candidates, folders.candidates),
      latency_ms: Math.round(this.now() - input.arrivedAt),
      agent: input.source,
      sources: { sessions: sessions.state, folders: folders.state, pages: 'none' }
    }
    this.sink.push(record)
  }

  private isOff(): Promise<boolean> {
    return access(join(this.deps.logsDirectory, PRIOR_WORK_SHADOW_OFF_FILE)).then(
      () => true,
      () => false
    )
  }

  private async sessionCandidates(input: ShadowInput): Promise<SourceResult> {
    const service = this.deps.sessionSearch()
    // Why ready only: a search before the delayed start would begin indexing early (session-search-service.ts).
    if (!service || service.state !== 'ready') {
      return { state: 'unavailable', candidates: [] }
    }
    const terms = priorWorkQueryTerms(input.prompt)
    if (terms.length === 0) {
      return { state: 'ok', candidates: [] }
    }
    // Why one at a time: a burst of new sessions must not queue searches behind the indexer.
    if (this.searchInFlight) {
      return { state: 'busy', candidates: [] }
    }
    this.searchInFlight = true
    try {
      const { hits } = await service.search(terms.join(' '), SESSION_HIT_LIMIT)
      const candidates = hits
        .filter((hit) => hit.sessionId !== input.sessionId)
        .map((hit) => ({
          kind: 'session' as const,
          ref: hit.sessionKey,
          title: hit.title,
          score: hit.score
        }))
      return { state: 'ok', candidates }
    } finally {
      this.searchInFlight = false
    }
  }

  private async folderCandidates(prompt: string): Promise<SourceResult> {
    const names = await this.projectFolderNames()
    if (!names) {
      return { state: 'unavailable', candidates: [] }
    }
    const candidates = rankProjectFolders(names, prompt).map(({ name, score }) => ({
      kind: 'folder' as const,
      ref: join(this.deps.projectsDirectory, name),
      title: name,
      score
    }))
    return { state: 'ok', candidates }
  }

  private projectFolderNames(): Promise<string[] | null> {
    const now = this.now()
    if (!this.folderList || now - this.folderList.at > FOLDER_LIST_TTL_MS) {
      const names = readdir(this.deps.projectsDirectory, { withFileTypes: true }).then(
        (entries) =>
          entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name),
        () => null
      )
      this.folderList = { at: now, names }
    }
    return this.folderList.names
  }
}

/** Null when switched off at launch; the hook server then skips the shadow entirely. */
export function createPriorWorkShadow(deps: PriorWorkShadowDeps): PriorWorkShadow | null {
  return process.env[PRIOR_WORK_SHADOW_DISABLED_ENV] === '1' ? null : new PriorWorkShadow(deps)
}
