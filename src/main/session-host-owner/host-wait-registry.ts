/**
 * Waits other computers registered on this host's conversations (`wait.register`), held on disk.
 * A wait is satisfied only by the awaited conversation's own result on this host, read after the
 * wait was registered and stamped with its owner epoch and outcome revision. A deadline ends it
 * unmet; nothing else (a closed transport, a restart) ever satisfies it.
 */

import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SessionHostWaitReceipt } from '../../shared/session-host-protocol'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'

export type HostWaitRecord = {
  registration: string
  dependency: string
  waiter: { hostId: string; conversationId: string }
  registeredAt: number
  deadline?: number
  state: SessionHostWaitReceipt['state']
  satisfiedBy?: NonNullable<SessionHostWaitReceipt['satisfiedBy']>
}

/** The awaited conversation's result on this host, read since a time; null when none yet. */
export type HostWaitResultReader = (
  dependency: string,
  since: number
) => { ownerEpoch: number; outcomeRevision: string; at: number } | null

type WaitFile = { v: 1; waits: Record<string, HostWaitRecord> }

const MAX_SETTLED = 2_000

function readWaits(file: string): Record<string, HostWaitRecord> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<WaitFile>
    return parsed.v === 1 && parsed.waits && typeof parsed.waits === 'object' ? parsed.waits : {}
  } catch {
    return {}
  }
}

export function hostWaitReceipt(record: HostWaitRecord): SessionHostWaitReceipt {
  return {
    registration: record.registration,
    dependency: record.dependency,
    state: record.state,
    ...(record.state === 'satisfied' && record.satisfiedBy
      ? { satisfiedBy: record.satisfiedBy }
      : {})
  }
}

export class HostWaitRegistry {
  private waits: Record<string, HostWaitRecord> | null = null
  private saving: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now
  ) {}

  private all(): Record<string, HostWaitRecord> {
    this.waits ??= readWaits(this.file)
    return this.waits
  }

  /** Idempotent per registration id: a repeat returns the record already held. */
  async register(input: Omit<HostWaitRecord, 'state' | 'registeredAt'>): Promise<HostWaitRecord> {
    const waits = this.all()
    const held = waits[input.registration]
    if (held) {
      return held
    }
    const record: HostWaitRecord = { ...input, registeredAt: this.now(), state: 'registered' }
    waits[input.registration] = record
    await this.save()
    return record
  }

  async cancel(registration: string): Promise<HostWaitRecord | null> {
    const record = this.all()[registration]
    if (!record) {
      return null
    }
    if (record.state === 'registered') {
      record.state = 'cancelled'
      await this.save()
    }
    return record
  }

  /** Reads each open wait's result once, and ends the ones past their deadline unmet. */
  async refresh(read: HostWaitResultReader): Promise<void> {
    let changed = false
    const now = this.now()
    for (const record of Object.values(this.all())) {
      if (record.state !== 'registered') {
        continue
      }
      const result = read(record.dependency, record.registeredAt)
      if (result) {
        record.state = 'satisfied'
        record.satisfiedBy = result
        changed = true
      } else if (record.deadline !== undefined && now >= record.deadline) {
        record.state = 'ended-unmet'
        changed = true
      }
    }
    if (changed) {
      await this.save()
    }
  }

  get(registration: string): HostWaitRecord | null {
    return this.all()[registration] ?? null
  }

  /** Whether a wait still stands on this conversation (a registered one, not yet met). */
  awaited(dependency: string): boolean {
    return Object.values(this.all()).some(
      (record) => record.dependency === dependency && record.state === 'registered'
    )
  }

  flush(): Promise<void> {
    return this.saving
  }

  private save(): Promise<void> {
    const waits = this.all()
    const settled = Object.values(waits)
      .filter((record) => record.state !== 'registered')
      .sort((a, b) => a.registeredAt - b.registeredAt)
    for (const record of settled.slice(0, Math.max(0, settled.length - MAX_SETTLED))) {
      delete waits[record.registration]
    }
    const json = JSON.stringify({ v: 1, waits } satisfies WaitFile)
    const file = this.file
    // Why chained: two quick registrations must land in order, each after the one before.
    this.saving = this.saving
      .catch(() => {})
      .then(() => mkdir(dirname(file), { recursive: true }))
      .then(() => writeFileDurable(durableWriteTempPath(file), file, json))
    return this.saving
  }
}
