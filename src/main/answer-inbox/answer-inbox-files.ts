/**
 * The hook-first pilot's two files in userData: the pending routes (so an answer waiting for a hook
 * survives an app restart, as a typed queue entry does) and the measurement JSONL.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { appendFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ANSWER_DELIVERY_PILOT_FILE,
  type AnswerDeliveryPilotRecord
} from '../../shared/answer-delivery-pilot-report'
import type { HookFirstSnapshot } from './hook-first-route'

const PENDING_FILE = 'answer-inbox-pending.json'
const PILOT_ROTATE_BYTES = 5 * 1024 * 1024

export function readHookFirstSnapshot(userDataPath: string): HookFirstSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(join(userDataPath, PENDING_FILE), 'utf8')) as unknown
    const record = parsed as Partial<HookFirstSnapshot> | null
    return record && Array.isArray(record.routes) && Array.isArray(record.items)
      ? { routes: record.routes, items: record.items }
      : null
  } catch {
    return null
  }
}

export function writeHookFirstSnapshot(userDataPath: string, snapshot: HookFirstSnapshot): void {
  const file = join(userDataPath, PENDING_FILE)
  const temp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 })
    renameSync(temp, file)
  } catch (error) {
    console.warn('[answer-inbox] could not save pending answers', error)
  }
}

/** Appends pilot lines in order; the file rotates to `.1` past 5 MB. */
export function answerDeliveryPilotLog(
  userDataPath: string
): (record: AnswerDeliveryPilotRecord) => Promise<void> {
  const file = join(userDataPath, ANSWER_DELIVERY_PILOT_FILE)
  let chain: Promise<void> = Promise.resolve()
  return (record) => {
    chain = chain
      .then(async () => {
        const size = await stat(file).then(
          (info) => info.size,
          () => 0
        )
        if (size > PILOT_ROTATE_BYTES) {
          await rename(file, `${file}.1`)
        }
        await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      })
      .catch((error) => console.warn('[answer-inbox] pilot log write failed', error))
    return chain
  }
}
