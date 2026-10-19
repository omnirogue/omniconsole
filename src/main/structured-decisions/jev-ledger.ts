import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { JEV_CALL_SCHEMA, type JevCallRow } from '../../shared/jev-ledger'

export const JEV_LEDGER_MAX_FILE_BYTES = 16 * 1024 * 1024
export const JEV_CALLS_FILE = 'calls.jsonl'
export const JEV_OUTCOMES_FILE = 'outcomes.jsonl'
export const JEV_LEDGER_MAX_ROW_BYTES = 1024 * 1024
const MAX_PENDING_WRITES = 1000
const APPEND_FLAGS =
  constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0)

export type JevCallFields = Omit<JevCallRow, 'schema' | 'host' | 'runtime_id'>
export type JevLedgerWrite = 'saved' | 'failed'

let current: JevLedger | undefined

/**
 * The append-only per-runtime JEV ledger: one `jev-call/1` line per call attempt, and separate
 * `jev-outcome/1` labels. One in-process queue is the only writer of both files.
 */
export class JevLedger {
  private tail: Promise<unknown> = Promise.resolve()
  private pending = 0
  private failures = 0

  constructor(
    readonly directory: string,
    private readonly identity: { host: string; runtimeId: string | null },
    private readonly maxFileBytes = JEV_LEDGER_MAX_FILE_BYTES
  ) {}

  get writeFailures(): number {
    return this.failures
  }

  countFailure(): void {
    this.failures++
  }

  /** Never rejects or throws: a failed or dropped row is counted and reported to the caller. */
  appendCall(fields: JevCallFields): Promise<JevLedgerWrite> {
    let line: string
    try {
      const row: JevCallRow = {
        schema: JEV_CALL_SCHEMA,
        record_key: fields.record_key,
        request_id: fields.request_id,
        observed_at: fields.observed_at,
        host: this.identity.host,
        runtime_id: this.identity.runtimeId,
        caller: fields.caller,
        transport: fields.transport,
        deadline_ms: fields.deadline_ms,
        model: fields.model,
        ref: fields.ref,
        ref_hash: fields.ref_hash,
        input_hash: fields.input_hash,
        question_ids: fields.question_ids,
        status: fields.status,
        provider_status: fields.provider_status,
        kind: fields.kind,
        reason: fields.reason,
        answers: fields.answers,
        usage: fields.usage,
        elapsed_ms: fields.elapsed_ms,
        calls: fields.calls
      }
      line = `${JSON.stringify(row)}\n`
    } catch {
      this.failures++
      return Promise.resolve('failed')
    }
    return this.exclusive(() => this.append(JEV_CALLS_FILE, line, true)).then(
      () => 'saved' as const,
      () => {
        this.failures++
        return 'failed' as const
      }
    )
  }

  /** Writes, and checks that must not interleave with writes, run one at a time. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending >= MAX_PENDING_WRITES) {
      return Promise.reject(new Error('The JEV ledger write queue is full.'))
    }
    this.pending++
    const run = this.tail.then(work).finally(() => {
      this.pending--
    })
    this.tail = run.catch(() => undefined)
    return run
  }

  /** Callers hold `exclusive`; a full calls file is renamed before it would reach its limit. */
  async append(file: string, line: string, rotate = false): Promise<void> {
    const bytes = Buffer.byteLength(line)
    if (bytes > JEV_LEDGER_MAX_ROW_BYTES) {
      throw new Error('JEV ledger row exceeds its size limit.')
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      await chmod(this.directory, 0o700)
    }
    const path = join(this.directory, file)
    if (rotate) {
      // One spare byte for the newline that may close a torn last line.
      await this.rotateBefore(path, bytes + 1)
    }
    const handle = await open(path, APPEND_FLAGS, 0o600)
    try {
      const entry = await handle.stat()
      if (!entry.isFile()) {
        throw new Error('JEV ledger path is not a regular file.')
      }
      if (process.platform !== 'win32') {
        await handle.chmod(0o600)
      }
      // Why: a crash or full disk can leave a partial last line. A row glued to it would be
      // reported saved yet never read back, so it starts on a fresh line.
      const last = Buffer.alloc(1)
      const torn =
        entry.size > 0 &&
        (await handle.read(last, 0, 1, entry.size - 1)).bytesRead === 1 &&
        last[0] !== 0x0a
      await handle.appendFile(torn ? `\n${line}` : line)
      await handle.datasync()
    } finally {
      await handle.close()
    }
  }

  private async rotateBefore(path: string, bytes: number): Promise<void> {
    const size = await stat(path).then(
      (entry) => entry.size,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return 0
        }
        throw error
      }
    )
    if (size === 0 || size + bytes < this.maxFileBytes) {
      return
    }
    const stamp = new Date().toISOString().replace(/[-:.]/g, '')
    for (let suffix = 0; ; suffix++) {
      // Every ordinal, including zero, must sort in append order for export cursors.
      const ordinal = String(suffix).padStart(16, '0')
      const target = join(this.directory, `calls-${stamp}-${ordinal}.jsonl`)
      const taken = await lstat(target).then(
        () => true,
        () => false
      )
      if (!taken) {
        await rename(path, target)
        return
      }
    }
  }
}

/** A record's row status without letting a slow disk hold back the JEV result. */
export async function ledgerWriteWithin(
  write: Promise<JevLedgerWrite>,
  waitMs = 1000
): Promise<JevLedgerWrite | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      write,
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), waitMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function installJevLedger(
  directory: string,
  identity: { host: string; runtimeId: string | null }
): JevLedger {
  current = new JevLedger(directory, identity)
  return current
}

export function uninstallJevLedger(ledger: JevLedger): void {
  if (current === ledger) {
    current = undefined
  }
}

/** The installed runtime's ledger; absent before the structured decision runtime starts. */
export function jevCallLedger(): JevLedger | undefined {
  return current
}
