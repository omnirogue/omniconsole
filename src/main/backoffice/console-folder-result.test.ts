import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ConsoleJobArtifactReceipt } from '../../shared/console-job-results'
import { decodeConsoleFolderResult } from './console-folder-result'

const jobId = 'job_folder1234'
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const file = (path: string, content = Buffer.from('Produced result\n')) => ({
  path,
  mode: 0o644,
  sha256: digest(content),
  size_bytes: content.length,
  content_b64: content.toString('base64')
})
const report = () => ({
  schema_version: 1,
  kind: 'folder_report',
  job_id: jobId,
  attempt: 2,
  response: 'Created the result and removed the old file. ✅',
  changed_files: ['old.txt', 'reports/result.txt'],
  files: [file('reports/result.txt')]
})
const pinFor = (bytes: Buffer): ConsoleJobArtifactReceipt => ({
  job_id: jobId,
  attempt: 2,
  file_id: 'tfl_folder1234',
  principal: 'sal',
  sha256: digest(bytes),
  rel: `${jobId}-2-folder-result.json`,
  size_bytes: bytes.length
})
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value))
const decode = (value: unknown) => {
  const bytes = encode(value)
  return decodeConsoleFolderResult(bytes, pinFor(bytes))
}

describe('pinned folder report decoding', () => {
  it('accepts the same pinned report carrier for a repository handoff', () => {
    const value = { ...report(), kind: 'handoff_report' }
    expect(decode(value)).toMatchObject({ response: value.response, files: value.files })
  })

  it('retains the response, removed paths, and exact produced binary, empty, and executable files', () => {
    const value = report()
    value.files = [
      file('binary.dat', Buffer.from([0, 255, 4, 128])),
      file('empty.txt', Buffer.alloc(0)),
      { ...file('run.sh', Buffer.from('#!/bin/sh\nexit 0\n')), mode: 0o755 }
    ]
    const bytes = encode(value)
    const receipt = pinFor(bytes)
    expect(decodeConsoleFolderResult(bytes, receipt)).toEqual({
      job_id: jobId,
      attempt: 2,
      receipt,
      response: value.response,
      changed_files: value.changed_files,
      files: value.files
    })
  })

  it.each([
    { sha256: '0'.repeat(64) },
    { size_bytes: 1 },
    { job_id: 'job_other1234' },
    { attempt: 3 },
    { attempt: 0 },
    { file_id: '../file' },
    { rel: '../folder-result.json' }
  ])('rejects a receipt whose byte or attempt identity differs: %j', (change) => {
    const bytes = encode(report())
    expect(() => decodeConsoleFolderResult(bytes, { ...pinFor(bytes), ...change })).toThrow()
  })

  it('rejects changed bytes even when their length is unchanged', () => {
    const bytes = encode(report())
    const changed = Buffer.from(bytes.toString().replace('Created', 'Altered'))
    expect(changed.length).toBe(bytes.length)
    expect(() => decodeConsoleFolderResult(changed, pinFor(bytes))).toThrow(/receipt/)
  })

  it.each([
    (json: string) => json.replace('"attempt":2', '"attempt":1,"attempt":2'),
    (json: string) => json.replace('"mode":420', '"mode":0,"m\\u006fde":420'),
    (json: string) => json.replace('"attempt":2', '"attempt":1e400'),
    (json: string) => json.replace('"attempt":2', '"attempt":2.0'),
    (json: string) => json.replace('"mode":420', '"mode":4.2e2'),
    (json: string) => `${json.slice(0, -1)},}`,
    (json: string) => `/* report */${json}`,
    (json: string) => `\uFEFF${json}`
  ])('rejects ambiguous or non-JSON reports even with matching receipts', (mutate) => {
    const bytes = Buffer.from(mutate(JSON.stringify(report())))
    expect(() => decodeConsoleFolderResult(bytes, pinFor(bytes))).toThrow()
  })

  it('rejects malformed UTF-8 instead of replacing it with a display character', () => {
    const bytes = Buffer.concat([
      Buffer.from('{"response":"'),
      Buffer.from([0xc0, 0xaf]),
      Buffer.from('"}')
    ])
    expect(() => decodeConsoleFolderResult(bytes, pinFor(bytes))).toThrow()
  })

  it.each([
    { schema_version: 2 },
    { kind: 'artifact' },
    { attempt: true },
    { attempt: 2.5 },
    { response: '  \n' },
    { response: '\ud800' },
    { response: '😀'.repeat(262_145) },
    { extra: 'not admitted' },
    { changed_files: ['z.txt', 'a.txt'] },
    { changed_files: ['same.txt', 'same.txt'] },
    { changed_files: Array.from({ length: 4097 }, (_, index) => `${index}.txt`) }
  ])('rejects invalid bounded envelope case %#', (change) => {
    expect(() => decode({ ...report(), ...change })).toThrow()
  })

  it('accepts a response at the exact UTF-8 byte limit', () => {
    const value = { ...report(), response: '😀'.repeat(262_144) }
    expect(decode(value).response).toBe(value.response)
  })

  it.each([
    '/absolute.txt',
    'C:/absolute.txt',
    'C:drive-relative.txt',
    'dir\\file.txt',
    'dir//file.txt',
    './file.txt',
    'dir/../file.txt',
    '.GIT/config',
    'dir/.git/config',
    'dir/line\n.txt',
    'dir/delete\u007f.txt',
    '\ud800.txt',
    'x'.repeat(1025)
  ])('rejects unsafe path case %# in snapshots and changed-file lists', (path) => {
    expect(() => decode({ ...report(), files: [file(path)] })).toThrow()
    expect(() => decode({ ...report(), changed_files: [path] })).toThrow()
  })

  it('matches Python codepoint ordering and path length for non-BMP filenames', () => {
    const paths = ['\uE000.txt', '😀'.repeat(1024)]
    const result = decode({
      ...report(),
      changed_files: paths,
      files: paths.map((path) => file(path))
    })
    expect(result.files.map((entry) => entry.path)).toEqual(paths)
    expect(() => decode({ ...report(), files: result.files.toReversed() })).toThrow(/sorted/)
  })

  it.each([
    { mode: 0o4755 },
    { mode: -1 },
    { mode: 1.5 },
    { sha256: '0'.repeat(64) },
    { sha256: 'A'.repeat(64) },
    { size_bytes: -1 },
    { size_bytes: 10 * 1024 * 1024 + 1 },
    { size_bytes: 1.5 },
    { size_bytes: true },
    { content_b64: 'not base64' },
    { extra: 'not admitted' }
  ])('rejects mismatched or out-of-contract file metadata: %j', (change) => {
    expect(() => decode({ ...report(), files: [{ ...file('result.txt'), ...change }] })).toThrow()
  })

  it('rejects noncanonical base64 padding bits and whitespace accepted by Buffer', () => {
    for (const encoded of ['Zh==', 'Zg=\n']) {
      const snapshot = { ...file('result.txt', Buffer.from('f')), content_b64: encoded }
      expect(Buffer.from(encoded, 'base64').toString()).toBe('f')
      expect(() => decode({ ...report(), files: [snapshot] })).toThrow(/digest and size/)
    }
  })

  it.each([
    ['same.txt', 'same.txt'],
    ['z.txt', 'a.txt'],
    ['dir', 'dir/child.txt']
  ])('rejects duplicate, unsorted, or overlapping file paths: %j', (...paths) => {
    expect(() => decode({ ...report(), files: paths.map((path) => file(path)) })).toThrow()
  })

  it('rejects more than the admitted number of files', () => {
    const files = Array.from({ length: 4097 }, (_, index) => file(`${index}.txt`, Buffer.alloc(0)))
    expect(() => decode({ ...report(), files })).toThrow()
  })

  it('rejects individually valid files whose total exceeds 32 MiB', () => {
    const content = Buffer.alloc(8 * 1024 * 1024 + 1, 1)
    const files = ['a.bin', 'b.bin', 'c.bin', 'd.bin'].map((path) => file(path, content))
    expect(() => decode({ ...report(), files })).toThrow(/total 32 MiB/)
  })

  it('rejects a report beyond its 48 MiB byte limit before parsing', () => {
    const valid = encode(report())
    const oversized = Buffer.alloc(48 * 1024 * 1024 + 1)
    expect(() => decodeConsoleFolderResult(oversized, pinFor(valid))).toThrow(/receipt/)
  })
})
