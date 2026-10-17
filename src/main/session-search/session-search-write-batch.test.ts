import { describe, expect, it } from 'vitest'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchWriteBatch } from './session-search-write-batch'

/** Fake db whose outer transaction vanishes (as after an IOERR auto-rollback) once `lose()` runs. */
function fakeDb(): { db: SyncDatabase; lose: () => void; log: string[] } {
  const log: string[] = []
  let open = false
  const db = {
    exec(sql: string): void {
      log.push(sql)
      if (sql.startsWith('BEGIN')) {
        open = true
      } else if (!open && sql.startsWith('ROLLBACK TO')) {
        throw new Error('no such savepoint: s1')
      } else if (!open && (sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK'))) {
        throw new Error('cannot commit - no transaction is active')
      } else if (sql.startsWith('COMMIT') || sql === 'ROLLBACK') {
        open = false
      }
    }
  } as unknown as SyncDatabase
  return { db, lose: () => (open = false), log }
}

describe('SessionSearchWriteBatch outer rollback', () => {
  it('rethrows the original error and recovers for the next batch', () => {
    const { db, lose, log } = fakeDb()
    const batch = new SessionSearchWriteBatch(db)
    batch.begin()
    expect(() =>
      batch.transaction(() => {
        lose()
        throw new Error('disk I/O error')
      })
    ).toThrow('disk I/O error')
    expect(() => batch.roll(0)).not.toThrow()
    batch.begin()
    expect(log.filter((sql) => sql === 'BEGIN')).toHaveLength(2)
    expect(() => batch.end()).not.toThrow()
  })

  it('end() resets instead of throwing when the batch was rolled back', () => {
    const { db, lose, log } = fakeDb()
    const batch = new SessionSearchWriteBatch(db)
    batch.begin()
    lose()
    expect(() => batch.end()).not.toThrow()
    batch.begin()
    expect(log.filter((sql) => sql === 'BEGIN')).toHaveLength(2)
  })
})
