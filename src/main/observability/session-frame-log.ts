// Session frame log writer (session-count fix, step 0). One bounded, rotated NDJSON file under the
// app's logs directory, switched on and off at runtime (omni session frame-log on|off) without a
// restart. Main-side owner records and renderer receiver records land in the same file.
//
// Why a flag file with an expiry: the acceptance captures include a restart, so "on" survives one,
// but only until it expires (default 8 h, at most 48 h); rotation bounds the footprint meanwhile.
// Why the async sink: records are written off the event loop, so logging never stalls main.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import {
  parseBuildCommit,
  SESSION_FRAME_LOG_DEFAULT_DURATION_MS,
  SESSION_FRAME_LOG_MAX_DURATION_MS,
  type SessionFrameLogBuild,
  type SessionFrameLogRecord,
  type SessionFrameLogStatus
} from '../../shared/session-frame-log'
import { createAsyncLocalFileSink } from './async-local-file-sink'
import { getLogsDirectory } from './logs-directory'
import { getRotatedFamilySize, listRotatedFiles } from './local-file-sink'

const SESSION_FRAME_LOG_FILE = 'session-frames.ndjson'
const SESSION_FRAME_LOG_FLAG_FILE = 'session-frames.on'
const SESSION_FRAME_LOG_MAX_BYTES = 10 * 1024 * 1024
const SESSION_FRAME_LOG_MAX_FILES = 8

export type SessionFrameLogWriter = { push(record: unknown): void; flush(): Promise<void> }

type WriterFactory = (filePath: string) => SessionFrameLogWriter

const defaultWriterFactory: WriterFactory = (filePath) =>
  createAsyncLocalFileSink({
    filePath,
    maxBytes: SESSION_FRAME_LOG_MAX_BYTES,
    maxFiles: SESSION_FRAME_LOG_MAX_FILES,
    warnLabel: 'session-frame-log'
  })

let writerFactory: WriterFactory = defaultWriterFactory
let directoryOverride: string | null = null
let enabled = false
let writer: SessionFrameLogWriter | null = null
let enabledAt: number | null = null
let expiresAt: number | null = null
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let closingFlush: Promise<void> = Promise.resolve()
let sequence = 0
const listeners = new Set<(enabled: boolean) => void>()

function logsDirectory(): string {
  return directoryOverride ?? getLogsDirectory()
}

function getSessionFrameLogFilePath(): string {
  return join(logsDirectory(), SESSION_FRAME_LOG_FILE)
}

function flagFilePath(): string {
  return join(logsDirectory(), SESSION_FRAME_LOG_FLAG_FILE)
}

export function getRunningBuildIdentity(): SessionFrameLogBuild {
  let appVersion: string | null = null
  try {
    appVersion = hasAppEnvironment() ? getAppEnvironment().getVersion() : null
  } catch {
    appVersion = null
  }
  return { appVersion, commit: parseBuildCommit(appVersion) }
}

/** The hot-path check every call site makes before building a record. */
export function isSessionFrameLogEnabled(): boolean {
  return enabled
}

export function recordSessionFrameLog(record: SessionFrameLogRecord): void {
  if (!enabled || !writer) {
    return
  }
  sequence += 1
  // Why stripped: t/seq/pid are this writer's ordering keys; no record may supply its own.
  const { t: _t, seq: _seq, pid: _pid, ...fields } = record
  try {
    writer.push({ t: Date.now(), seq: sequence, pid: process.pid, ...fields })
  } catch {
    /* a debug log must never break the path it observes */
  }
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener(enabled)
    } catch {
      /* one listener failing must not keep the others stale */
    }
  }
}

function clampDuration(durationMs: number | undefined): number {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) {
    return SESSION_FRAME_LOG_DEFAULT_DURATION_MS
  }
  return Math.min(durationMs, SESSION_FRAME_LOG_MAX_DURATION_MS)
}

function armExpiry(at: number): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
  }
  expiresAt = at
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null
      setSessionFrameLogEnabled(false, 'expired')
    },
    Math.max(0, at - Date.now())
  )
  // Why unref: an armed debug expiry must never keep a quitting process alive.
  if (typeof expiryTimer.unref === 'function') {
    expiryTimer.unref()
  }
}

function openWriter(origin: string, until: number): boolean {
  try {
    writer = writerFactory(getSessionFrameLogFilePath())
    enabled = true
    enabledAt = Date.now()
    armExpiry(until)
    recordSessionFrameLog({
      kind: 'log.start',
      origin,
      expiresAt: until,
      build: getRunningBuildIdentity(),
      host: hostname(),
      platform: process.platform,
      // Why: the main bundle is minified, so owner writer frames are positions, not names.
      writerStacks:
        'minified main bundle: resolve positions with the hidden sourcemaps of this build'
    })
    return true
  } catch (error) {
    console.warn('[session-frame-log] could not open the frame log:', error)
    writer = null
    enabled = false
    enabledAt = null
    expiresAt = null
    return false
  }
}

function writeFlag(): void {
  try {
    mkdirSync(logsDirectory(), { recursive: true, mode: 0o700 })
    writeFileSync(flagFilePath(), `${JSON.stringify({ enabledAt, expiresAt })}\n`, {
      mode: 0o600
    })
  } catch (error) {
    console.warn('[session-frame-log] could not persist the frame log flag:', error)
  }
}

function removeFlag(): void {
  try {
    rmSync(flagFilePath(), { force: true })
  } catch (error) {
    console.warn('[session-frame-log] could not remove the frame log flag:', error)
  }
}

/** On: opens the log (or, already on, extends it) until `durationMs` from now (default 8 h, ≤ 48 h). */
export function setSessionFrameLogEnabled(
  next: boolean,
  origin: string,
  options: { durationMs?: number | undefined } = {}
): SessionFrameLogStatus {
  if (next) {
    const until = Date.now() + clampDuration(options.durationMs)
    if (!enabled) {
      if (openWriter(origin, until)) {
        writeFlag()
        notify()
      }
    } else {
      armExpiry(until)
      writeFlag()
      recordSessionFrameLog({ kind: 'log.extend', origin, expiresAt: until })
    }
  } else if (enabled) {
    recordSessionFrameLog({ kind: 'log.stop', origin })
    const closing = writer
    writer = null
    enabled = false
    enabledAt = null
    expiresAt = null
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer)
      expiryTimer = null
    }
    closingFlush = closing ? closing.flush().catch(() => {}) : Promise.resolve()
    removeFlag()
    notify()
  } else {
    // Why: a flag left by a crash before restore ran must still be removable.
    removeFlag()
  }
  return getSessionFrameLogStatus()
}

function readPersistedExpiry(): number | null {
  try {
    const parsed = JSON.parse(readFileSync(flagFilePath(), 'utf8')) as { expiresAt?: unknown }
    return typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt)
      ? parsed.expiresAt
      : null
  } catch {
    return null
  }
}

/** Startup: reopen the log when it was on before this process started and has not expired. */
export function restoreSessionFrameLogFromDisk(): void {
  try {
    if (enabled || !existsSync(flagFilePath())) {
      return
    }
    const until = readPersistedExpiry()
    // Why: a flag without a readable expiry predates the expiry or is damaged; never resume it.
    if (until === null || until <= Date.now()) {
      removeFlag()
      return
    }
    if (openWriter('restored-after-start', until)) {
      notify()
    }
  } catch {
    /* a debug flag must never block startup */
  }
}

/** Resolves once every queued record, including a just-closed log's, is on disk. */
export async function flushSessionFrameLog(): Promise<void> {
  try {
    await Promise.all([closingFlush, writer?.flush()])
  } catch {
    /* best effort on quit */
  }
}

export function getSessionFrameLogStatus(): SessionFrameLogStatus {
  const filePath = getSessionFrameLogFilePath()
  return {
    enabled,
    filePath,
    files: listRotatedFiles(filePath, SESSION_FRAME_LOG_MAX_FILES),
    bytes: getRotatedFamilySize(filePath, SESSION_FRAME_LOG_MAX_FILES),
    maxBytes: SESSION_FRAME_LOG_MAX_BYTES,
    maxFiles: SESSION_FRAME_LOG_MAX_FILES,
    enabledAt,
    expiresAt,
    build: getRunningBuildIdentity()
  }
}

export function onSessionFrameLogEnabledChanged(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function _configureSessionFrameLogForTests(options: {
  directory?: string | null
  writerFactory?: WriterFactory | null
}): void {
  if (options.directory !== undefined) {
    directoryOverride = options.directory
  }
  if (options.writerFactory !== undefined) {
    writerFactory = options.writerFactory ?? defaultWriterFactory
  }
}

/** Simulates a process exit: drops module state (after flushing), keeps files on disk. */
export async function _resetSessionFrameLogForTests(): Promise<void> {
  await flushSessionFrameLog()
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
  }
  expiryTimer = null
  writer = null
  enabled = false
  enabledAt = null
  expiresAt = null
  sequence = 0
  closingFlush = Promise.resolve()
  listeners.clear()
  directoryOverride = null
  writerFactory = defaultWriterFactory
}
