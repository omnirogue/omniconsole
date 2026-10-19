import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readDeliveredFile } from './delivered-file-read'

describe('readDeliveredFile', () => {
  const root = mkdtempSync(join(tmpdir(), 'delivered-file-'))

  it('hashes a regular file and reports its size and time', async () => {
    const path = join(root, 'a.md')
    writeFileSync(path, 'hello')
    const read = await readDeliveredFile(path)
    expect(read).toMatchObject({
      status: 'file',
      size: 5,
      hash: createHash('sha256').update('hello').digest('hex')
    })
  })

  it('says a folder is not a file', async () => {
    const path = join(root, 'dir')
    mkdirSync(path)
    expect(await readDeliveredFile(path)).toMatchObject({ status: 'not-file', isDirectory: true })
  })

  it('reports ENOENT for nothing there', async () => {
    expect(await readDeliveredFile(join(root, 'missing.md'))).toEqual({
      status: 'unreadable',
      code: 'ENOENT'
    })
  })
})
