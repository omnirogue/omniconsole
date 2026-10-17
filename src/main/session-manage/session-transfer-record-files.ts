/**
 * Where the requesting computer keeps its durable records of transfers and relocations: one JSON
 * file each, written with an fsync'd rename before the step it describes is sent, named by the
 * operation id that started it.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSessionHostOperationId } from '../../shared/session-host-identity'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'

export type SessionTransferRecordStore<T> = {
  read(id: string): Promise<T | null>
  write(record: T): Promise<void>
}

export function fileSessionTransferRecords<T extends { v: 1 }>(
  dir: string,
  idOf: (record: T) => string
): SessionTransferRecordStore<T> {
  const pathOf = (id: string) => {
    if (!isSessionHostOperationId(id)) {
      throw new Error('A transfer or relocation is named by its operation id.')
    }
    return join(dir, `${id}.json`)
  }
  return {
    read: async (id) => {
      try {
        const record = JSON.parse(readFileSync(pathOf(id), 'utf8')) as T
        return record.v === 1 && idOf(record) === id ? record : null
      } catch {
        return null
      }
    },
    write: async (record) => {
      mkdirSync(dir, { recursive: true })
      const path = pathOf(idOf(record))
      writeFileDurableSync(durableWriteTempPath(path), path, `${JSON.stringify(record, null, 2)}\n`)
    }
  }
}

export function memorySessionTransferRecords<T>(
  idOf: (record: T) => string
): SessionTransferRecordStore<T> & { records: Map<string, T> } {
  const records = new Map<string, T>()
  return {
    records,
    read: async (id) => {
      const record = records.get(id)
      return record ? structuredClone(record) : null
    },
    write: async (record) => {
      records.set(idOf(record), structuredClone(record))
    }
  }
}
