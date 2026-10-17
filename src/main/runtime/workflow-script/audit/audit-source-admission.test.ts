import {
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureAuditCorpus, readAuditSources } from './audit-snapshot'
import * as boundedReader from '../../../../shared/node-bounded-file-reader'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'audit-source-admission-'))
  roots.push(root)
  const source = { id: 'S1', timestamp: '2026-10-02T12:00:00Z', text: 'Corpus evidence 🐋' }
  const file = join(root, 'sources.jsonl')
  writeFileSync(file, JSON.stringify(source))
  return { root, file, source }
}
afterEach(() => {
  vi.restoreAllMocks()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

describe('audit corpus file admission', () => {
  it('reads the opened regular file through the shared memory bound and closes it', () => {
    const { file, source } = fixture()
    const read = vi.spyOn(boundedReader, 'readNodeFileSyncWithinLimit')
    expect(readAuditSources(file, 'sources-jsonl')).toEqual([source])
    expect(read).toHaveBeenCalledWith(expect.any(Number), 32 * 1024 * 1024)
    const descriptor = read.mock.calls[0][0] as number
    expect(() => fstatSync(descriptor)).toThrow()
  })

  it('rejects an oversized sparse file before reading its body', () => {
    const { file } = fixture()
    const descriptor = openSync(file, 'r+')
    ftruncateSync(descriptor, 32 * 1024 * 1024 + 1)
    closeSync(descriptor)
    expect(() => readAuditSources(file, 'sources-jsonl')).toThrow(
      boundedReader.NodeFileReadTooLargeError
    )
  })

  it('rejects directories before invoking the bounded reader', () => {
    const { root } = fixture()
    const read = vi.spyOn(boundedReader, 'readNodeFileSyncWithinLimit')
    expect(() => readAuditSources(root, 'sources-jsonl')).toThrow()
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps execution-host paths explicit before canonicalization', () => {
    expect(() => captureAuditCorpus('relative-source.jsonl', 'sources-jsonl')).toThrow(
      'absolute execution-host path'
    )
    expect(() => readAuditSources('relative-source.jsonl', 'sources-jsonl')).toThrow(
      'absolute execution-host path'
    )
  })
})
