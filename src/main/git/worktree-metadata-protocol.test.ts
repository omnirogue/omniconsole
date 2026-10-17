import { describe, expect, it } from 'vitest'
import {
  createWorktreeMetadataDecoder,
  WORKTREE_METADATA_OUTPUT_BYTES
} from './worktree-metadata-protocol'
import {
  resolveWorktreeMetadataEntryPath,
  worktreeMetadataProcessSpec
} from './worktree-metadata-process'
import { join } from 'node:path'

describe('metadata child protocol', () => {
  it('accepts split complete records and refuses wrong indices, operations, duplicates and false absence without a code', () => {
    const accepted: unknown[] = []
    const decode = createWorktreeMetadataDecoder(
      [{ operation: 'exists', path: '/path' }],
      (record) => accepted.push(record)
    )
    const emit = (record: object) => decode(`${JSON.stringify(record)}\n`)
    decode('{"index":0,"operation":"exists",')
    decode('"phase":"start"}\n')
    emit({ index: -1, operation: 'exists', phase: 'result', value: false, code: 'ENOENT' })
    emit({ index: 0, operation: 'sparse', phase: 'result', value: true })
    emit({ index: 0, operation: 'exists', phase: 'result', value: false })
    emit({ index: 0, operation: 'exists', phase: 'result', value: false, code: 'ENOTDIR' })
    emit({ index: 0, operation: 'exists', phase: 'result', value: true })
    expect(accepted).toEqual([
      { index: 0, operation: 'exists', phase: 'start' },
      { index: 0, operation: 'exists', phase: 'result', value: false, code: 'ENOTDIR' }
    ])
  })

  it('accepts only an explicit readable proof after a matching start, without absence codes', () => {
    const accepted: unknown[] = []
    const decode = createWorktreeMetadataDecoder(
      [{ operation: 'readable', path: '/path' }],
      (record) => accepted.push(record)
    )
    const emit = (record: object) => decode(`${JSON.stringify(record)}\n`)
    const result = { index: 0, operation: 'readable', phase: 'result', value: true }
    emit(result)
    emit({ ...result, phase: 'start' })
    emit({ ...result, index: 1 })
    emit({ ...result, operation: 'exists' })
    emit({ ...result, value: false })
    emit({ ...result, value: false, code: 'ENOENT' })
    emit({ ...result, value: false, code: 'ENOTDIR' })
    emit({ ...result, code: 'ENOENT' })
    expect(accepted).toHaveLength(1)
    emit(result)
    expect(accepted).toHaveLength(2)
    expect(accepted[1]).toEqual(result)
  })

  it('caps malformed output instead of parsing a forged suffix', () => {
    const accepted: unknown[] = []
    const decode = createWorktreeMetadataDecoder(
      [{ operation: 'sparse', path: '/path' }],
      (record) => accepted.push(record)
    )
    decode('x'.repeat(WORKTREE_METADATA_OUTPUT_BYTES + 1))
    decode('\n{"index":0,"operation":"sparse","phase":"start"}\n')
    expect(accepted).toEqual([])
  })

  it('uses unpacked entries and an allowlisted environment on every platform', () => {
    const moduleDir = join('/app', 'app.asar', 'out', 'main', 'chunks')
    const expected = join(
      '/app',
      'app.asar.unpacked',
      'out',
      'main',
      'worktree-metadata-process-entry.js'
    )
    expect(
      resolveWorktreeMetadataEntryPath(moduleDir, undefined, (path) => path === expected)
    ).toBe(expected)
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const spec = worktreeMetadataProcessSpec(
        '/entry.js',
        {
          PATH: '/bin',
          NODE_OPTIONS: '--require secret.js',
          GOOGLE_TOKEN: 'secret',
          UV_THREADPOOL_SIZE: '128',
          systemroot: 'C:\\Windows'
        },
        platform
      )
      expect(spec.env).not.toHaveProperty('NODE_OPTIONS')
      expect(spec.env).not.toHaveProperty('GOOGLE_TOKEN')
      expect(spec.env?.UV_THREADPOOL_SIZE).toBe('8')
      expect(spec.env?.ELECTRON_RUN_AS_NODE).toBe('1')
      expect(spec.timeoutMs).toBe(2_000)
      expect(spec.terminationBarrier).toBeUndefined()
      if (platform === 'win32') {
        expect(spec.env?.SystemRoot).toBe('C:\\Windows')
      }
    }
  })
})
