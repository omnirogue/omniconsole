/**
 * The files each conversation's own write tools finished writing, keyed by the provider session
 * that wrote them, on this host's disk only. Fed by every accepted hook event (local, relayed or
 * replayed from the spool) before any renderer batching, so the right panel lists what a session
 * wrote for every provider (Gemini and Kimi have no transcript the app reads), after a restart,
 * and in whichever pane the session is resumed.
 */

import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeHookEventName } from '../../shared/agent-hook-listener/provider-event-names'
import { agentWriteToolOp, writeTargetPath } from '../../shared/agent-write-tools'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'

export const SESSION_WRITTEN_FILES_FILE = 'session-written-files.json'
export const SESSION_WRITTEN_FILES_MAX_SESSIONS = 500
export const SESSION_WRITTEN_FILES_PER_SESSION = 50
const MAX_ID_LENGTH = 4_096

// Why the end events: a write counts once the tool finished, not when it was proposed.
const TOOL_END_EVENTS = new Set(['post_tool_use', 'after_tool', 'tool_execution_end'])

export type SessionWrittenFilesSession = {
  provider: string
  sessionId: string
  /** The pane that last wrote, for clients that still look records up by pane. */
  paneKey: string | null
  paths: string[]
}

/** A record as the first release (version 1) kept it: by pane, with the session when known. */
export type LegacySessionWrittenFiles = {
  paneKey: string
  sessionId: string | null
  paths: string[]
}

/** What the store reads off one accepted hook event. */
export type SessionWrittenFilesObservation = {
  paneKey?: string
  source?: string
  hookEventName?: string
  providerSession?: { id?: string }
  payload: { agentType?: string; toolName?: string; toolInput?: string }
}

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH

const sessionKey = (provider: string, sessionId: string): string => `${provider}\u0000${sessionId}`

/** Each path once, where it was last written, oldest first. */
function latestUnique(paths: readonly string[]): string[] {
  return paths
    .filter((path, index) => paths.lastIndexOf(path) === index)
    .slice(-SESSION_WRITTEN_FILES_PER_SESSION)
}

function cleanPaths(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : [])
    .map((path) => (typeof path === 'string' ? writeTargetPath(path) : null))
    .filter((path): path is string => path !== null)
    .slice(-SESSION_WRITTEN_FILES_PER_SESSION)
}

function sanitizeSession(raw: unknown): SessionWrittenFilesSession | null {
  const entry = raw as Partial<SessionWrittenFilesSession> | null
  if (!entry || !validId(entry.provider) || !validId(entry.sessionId)) {
    return null
  }
  const paths = cleanPaths(entry.paths)
  const paneKey = validId(entry.paneKey) ? entry.paneKey : null
  return paths.length > 0
    ? { provider: entry.provider, sessionId: entry.sessionId, paneKey, paths }
    : null
}

function sanitizeLegacy(raw: unknown): LegacySessionWrittenFiles | null {
  const entry = raw as Partial<LegacySessionWrittenFiles> | null
  if (!entry || !validId(entry.paneKey)) {
    return null
  }
  const paths = cleanPaths(entry.paths)
  const sessionId = validId(entry.sessionId) ? entry.sessionId : null
  return paths.length > 0 ? { paneKey: entry.paneKey, sessionId, paths } : null
}

export class SessionWrittenFilesStore {
  private sessions = new Map<string, SessionWrittenFilesSession>()
  // Why kept: version-1 records carry no provider; they stay, and serve lookups by session id.
  private legacy: LegacySessionWrittenFiles[] = []
  private writeChain: Promise<void> = Promise.resolve()
  private writeQueued = false

  constructor(private readonly options: { directory: string }) {}

  private get path(): string {
    return join(this.options.directory, SESSION_WRITTEN_FILES_FILE)
  }

  load(): void {
    let raw: { sessions?: unknown; legacy?: unknown; conversations?: unknown } | null
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8')) as typeof raw
    } catch {
      return
    }
    const sessions = Array.isArray(raw?.sessions) ? raw.sessions : []
    const restored = new Map<string, SessionWrittenFilesSession>()
    for (const entry of sessions.slice(-SESSION_WRITTEN_FILES_MAX_SESSIONS)) {
      const valid = sanitizeSession(entry)
      if (valid) {
        restored.set(sessionKey(valid.provider, valid.sessionId), valid)
      }
    }
    this.sessions = restored
    // Why both names: version 1 wrote `conversations`; version 2 carries them on as `legacy`.
    const legacy = [
      ...(Array.isArray(raw?.legacy) ? raw.legacy : []),
      ...(Array.isArray(raw?.conversations) ? raw.conversations : [])
    ]
    this.legacy = legacy
      .map(sanitizeLegacy)
      .filter((entry): entry is LegacySessionWrittenFiles => entry !== null)
      .slice(-SESSION_WRITTEN_FILES_MAX_SESSIONS)
  }

  /** Idempotent, so a replayed event (a hook spooled while this host was down) is welcome too. */
  observe(event: SessionWrittenFilesObservation): void {
    const sessionId = event.providerSession?.id
    const provider = event.payload.agentType ?? event.source
    // Why: without the provider session that wrote it, a write is never attributed to anyone.
    if (!validId(sessionId) || !validId(provider) || provider === 'unknown') {
      return
    }
    const key = sessionKey(provider, sessionId)
    const adopted = this.adoptLegacy(key, provider, sessionId)
    const path =
      TOOL_END_EVENTS.has(normalizeHookEventName(event.hookEventName)) &&
      agentWriteToolOp(event.payload.toolName)
        ? writeTargetPath(event.payload.toolInput)
        : null
    const recorded = path !== null && this.record(key, provider, sessionId, event.paneKey, path)
    if (adopted || recorded) {
      this.persist()
    }
  }

  /** The files one provider session wrote, oldest first; empty for a session never seen. */
  pathsFor(provider: string, sessionId: string): string[] {
    // Why legacy by id alone: those records name no provider, and a session id names one session.
    const legacy = this.legacy.filter((entry) => entry.sessionId === sessionId)
    const current = this.sessions.get(sessionKey(provider, sessionId))?.paths ?? []
    return latestUnique([...legacy.flatMap((entry) => entry.paths), ...current])
  }

  /** The first release's shape, the latest-writing session per pane, for clients that read it. */
  listByPane(): LegacySessionWrittenFiles[] {
    const byPane = new Map<string, LegacySessionWrittenFiles>()
    const sessions = [...this.sessions.values()].flatMap((entry) =>
      entry.paneKey === null
        ? []
        : [{ paneKey: entry.paneKey, sessionId: entry.sessionId, paths: entry.paths }]
    )
    for (const record of [...this.legacy, ...sessions]) {
      byPane.delete(record.paneKey)
      byPane.set(record.paneKey, { ...record, paths: [...record.paths] })
    }
    return [...byPane.values()]
  }

  list(): SessionWrittenFilesSession[] {
    return [...this.sessions.values()].map((entry) => ({ ...entry, paths: [...entry.paths] }))
  }

  async flush(): Promise<void> {
    await this.writeChain
  }

  /** Moves this session's first-release records onto it once a hook names its provider. */
  private adoptLegacy(key: string, provider: string, sessionId: string): boolean {
    const adopted = this.legacy.filter((entry) => entry.sessionId === sessionId)
    if (adopted.length === 0) {
      return false
    }
    this.legacy = this.legacy.filter((entry) => entry.sessionId !== sessionId)
    const current = this.sessions.get(key)
    this.sessions.set(key, {
      provider,
      sessionId,
      paneKey: current?.paneKey ?? adopted.at(-1)?.paneKey ?? null,
      paths: latestUnique([...adopted.flatMap((entry) => entry.paths), ...(current?.paths ?? [])])
    })
    this.evictOldest()
    return true
  }

  private record(
    key: string,
    provider: string,
    sessionId: string,
    eventPaneKey: string | undefined,
    path: string
  ): boolean {
    const previous = this.sessions.get(key)
    const paneKey = validId(eventPaneKey) ? eventPaneKey : (previous?.paneKey ?? null)
    if (previous?.paths.at(-1) === path && previous.paneKey === paneKey) {
      return false
    }
    // Why delete first: Map order is insertion order, so the latest-writing session is last.
    this.sessions.delete(key)
    this.sessions.set(key, {
      provider,
      sessionId,
      paneKey,
      paths: latestUnique([...(previous?.paths ?? []), path])
    })
    this.evictOldest()
    return true
  }

  private evictOldest(): void {
    while (this.sessions.size > SESSION_WRITTEN_FILES_MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.sessions.delete(oldest)
    }
  }

  private persist(): void {
    if (this.writeQueued) {
      return
    }
    this.writeQueued = true
    const finalPath = this.path
    this.writeChain = this.writeChain
      .then(async () => {
        this.writeQueued = false
        const payload = JSON.stringify({ version: 2, sessions: this.list(), legacy: this.legacy })
        await mkdir(this.options.directory, { recursive: true })
        await writeFileDurable(durableWriteTempPath(finalPath), finalPath, payload)
      })
      .catch((error: unknown) => {
        console.error(`[session-written-files] saving ${finalPath} failed`, error)
      })
  }
}

let activeStore: SessionWrittenFilesStore | null = null

export function getSessionWrittenFilesStore(): SessionWrittenFilesStore | null {
  return activeStore
}

/**
 * Loads the store and subscribes it before the hook server starts, so the spool the server
 * drains at start (hooks written while this host was down) reaches it. Returns the flush for quit.
 */
export function startSessionWrittenFiles(options: {
  directory: string
  subscribe: (listener: (event: SessionWrittenFilesObservation) => void) => () => void
}): () => Promise<void> {
  const store = new SessionWrittenFilesStore({ directory: options.directory })
  store.load()
  activeStore = store
  const unsubscribe = options.subscribe((event) => store.observe(event))
  return () => {
    unsubscribe()
    if (activeStore === store) {
      activeStore = null
    }
    return store.flush()
  }
}
