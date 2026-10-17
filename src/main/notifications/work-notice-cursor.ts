import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import type { WorkNoticeCursor } from './work-notice-poller'

const id = z.union([z.string().min(1), z.number().int().nonnegative().safe()]).nullable()
const schema = z.object({ after: id, pending: id, seen: z.array(z.string()).max(200) })

export function readWorkNoticeCursor(path: string): WorkNoticeCursor {
  return existsSync(path)
    ? schema.parse(JSON.parse(readFileSync(path, 'utf8')))
    : { after: null, pending: null, seen: [] }
}

export function writeWorkNoticeCursor(path: string, cursor: WorkNoticeCursor): void {
  writeDurableSecureJsonFile(path, schema.parse(cursor))
}
