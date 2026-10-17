import { closeSync, openSync, readSync } from 'node:fs'
import type { SessionSearchAgent } from '../../shared/session-search-types'

/**
 * How a transcript's session was started, read from its first lines: a person's interactive
 * session, a headless one-shot run (`claude -p`, `codex exec`, OmniConsole's own helpers), or a
 * Codex worker another Codex session spawned (its parent's id). The omnios Work feed posts the
 * first kind and folds workers into their parent.
 */
export type TranscriptOrigin = {
  headless: boolean
  parentSessionId: string | null
  worker?: boolean
}

const CLAUDE_HEAD_BYTES = 64 * 1024
/** Codex's first line carries the whole base instructions; it is long but bounded. */
const CODEX_HEAD_BYTES = 1024 * 1024
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/

function readHead(path: string, maxBytes: number): string {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(maxBytes)
    const read = readSync(fd, buffer, 0, maxBytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      closeSync(fd)
    }
  }
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Codex: `session_meta.payload.source` is `cli`/`vscode`, `exec`, or a spawned worker. */
export function codexOrigin(firstLine: string): TranscriptOrigin {
  const payload = parse(firstLine)?.payload as Record<string, unknown> | undefined
  const source = payload?.source
  if (source && typeof source === 'object') {
    const spawn = (source as { subagent?: { thread_spawn?: { parent_thread_id?: unknown } } })
      .subagent?.thread_spawn
    const parent = spawn?.parent_thread_id
    if (typeof parent === 'string' && SESSION_ID.test(parent)) {
      return { headless: true, parentSessionId: parent.toLowerCase(), worker: true }
    }
    // Guardians and other internal workers may have no parent thread id.
    const worker = Boolean((source as { subagent?: unknown }).subagent)
    return { headless: true, parentSessionId: null, ...(worker ? { worker: true } : {}) }
  }
  return {
    headless: source === 'exec' || payload?.originator === 'codex_exec',
    parentSessionId: null
  }
}

/** Claude: every message line names its `entrypoint`; the SDK ones (`sdk-cli`, …) are headless. */
export function claudeOrigin(head: string): TranscriptOrigin {
  for (const line of head.split('\n')) {
    const entrypoint = parse(line)?.entrypoint
    if (typeof entrypoint === 'string') {
      return { headless: entrypoint.startsWith('sdk'), parentSessionId: null }
    }
  }
  return { headless: false, parentSessionId: null }
}

export function readTranscriptOrigin(path: string, agent: SessionSearchAgent): TranscriptOrigin {
  if (agent === 'codex') {
    const head = readHead(path, CODEX_HEAD_BYTES)
    const end = head.indexOf('\n')
    return codexOrigin(end !== -1 ? head.slice(0, end) : head)
  }
  return claudeOrigin(readHead(path, CLAUDE_HEAD_BYTES))
}
