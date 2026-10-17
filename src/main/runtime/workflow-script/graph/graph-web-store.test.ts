import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WEB_PAGE_MAX_BYTES } from '../../../web-pages/web-page-response'
import { GraphWebStore } from './graph-web-store'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-web-store-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const folder = () => join(dir, 'run-1', 'web')

describe('the web blob store of one run', () => {
  it('keeps text and body under their own hashes, beside the run, with hex names only', () => {
    const blobs = GraphWebStore.forExecution('run-1', dir)
    const text = 'Clean text — with “quotes”.'
    const raw = Buffer.from('<p>Clean text</p>')
    expect(blobs.putText(text)).toBe(sha256(text))
    expect(blobs.putRaw(raw)).toBe(sha256(raw))
    expect(readdirSync(folder()).sort()).toEqual(
      [`${sha256(text)}.txt`, `${sha256(raw)}.raw.gz`].sort()
    )
    expect(blobs.text(sha256(text))).toBe(text)
    expect(blobs.hasRaw(sha256(raw))).toBe(true)
  })

  it('writes a blob only when it is absent', () => {
    const blobs = GraphWebStore.forExecution('run-1', dir)
    const hash = blobs.putText('first')
    const file = join(folder(), `${hash}.txt`)
    writeFileSync(file, 'something else')
    expect(blobs.putText('first')).toBe(hash)
    expect(readFileSync(file, 'utf8')).toBe('something else')
    expect(blobs.text(hash)).toBeUndefined()
  })

  it('reads a changed, missing or non-hex blob as absent', () => {
    const blobs = GraphWebStore.forExecution('run-1', dir)
    const raw = Buffer.from('body')
    const rawHash = blobs.putRaw(raw)
    const textHash = blobs.putText('text')
    writeFileSync(join(folder(), `${rawHash}.raw.gz`), gzipSync(Buffer.from('bodY')))
    expect(blobs.hasRaw(rawHash)).toBe(false)
    writeFileSync(join(folder(), `${rawHash}.raw.gz`), Buffer.from('not gzip'))
    expect(blobs.hasRaw(rawHash)).toBe(false)
    // A swapped-in bomb stops at the fetch cap instead of filling memory.
    writeFileSync(
      join(folder(), `${rawHash}.raw.gz`),
      gzipSync(Buffer.alloc(WEB_PAGE_MAX_BYTES + 1))
    )
    expect(blobs.hasRaw(rawHash)).toBe(false)
    rmSync(join(folder(), `${textHash}.txt`))
    expect(blobs.text(textHash)).toBeUndefined()
    mkdirSync(join(dir, 'run-1', 'outside'), { recursive: true })
    writeFileSync(join(dir, 'run-1', 'outside', 'x.txt'), 'x')
    expect(blobs.text('../outside/x')).toBeUndefined()
    expect(blobs.text(textHash.toUpperCase())).toBeUndefined()
  })

  it('refuses an execution id that could leave the attempts folder', () => {
    expect(() => GraphWebStore.forExecution('../run', dir)).toThrow('Invalid workflow execution id')
    expect(() => GraphWebStore.forExecution('run/1', dir)).toThrow('Invalid workflow execution id')
  })

  it.skipIf(process.platform === 'win32')('keeps the folder 0700 and every blob 0600', () => {
    const blobs = GraphWebStore.forExecution('run-1', dir)
    blobs.putText('private')
    blobs.putRaw(Buffer.from('private'))
    expect(statSync(folder()).mode & 0o777).toBe(0o700)
    for (const name of readdirSync(folder())) {
      expect(statSync(join(folder(), name)).mode & 0o777).toBe(0o600)
    }
  })
})
