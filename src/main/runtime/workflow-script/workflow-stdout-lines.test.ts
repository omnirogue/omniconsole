import { describe, expect, it } from 'vitest'
import type { ProcessResult } from '../../../shared/child-process/process-spec'
import { createWorkflowStdoutLines } from './workflow-stdout-lines'

const captured = (patch: Partial<ProcessResult> = {}): ProcessResult => ({
  code: 0,
  signal: null,
  stdout: 'raw capture is ignored',
  stderr: 'warning',
  timedOut: false,
  ...patch
})

describe('workflow stdout lines', () => {
  it('reassembles lines across chunks, including a split multi-byte character', () => {
    const seen: string[] = []
    const lines = createWorkflowStdoutLines({
      maxBytes: 1024,
      storeLine: (line) => line,
      onLine: (line) => seen.push(line)
    })
    const bytes = Buffer.from('{"a":"é"}\n{"b":1}\npartial', 'utf8')
    const split = bytes.indexOf(0xa9)
    lines.write(bytes.subarray(0, split))
    lines.write(bytes.subarray(split, split + 3))
    lines.write(bytes.subarray(split + 3))
    const result = lines.result(captured())
    expect(seen).toEqual(['{"a":"é"}', '{"b":1}', 'partial'])
    // Nothing was filtered, so the stored text is the stream byte for byte.
    expect(result).toEqual({
      code: 0,
      signal: null,
      stdout: '{"a":"é"}\n{"b":1}\npartial',
      stderr: 'warning',
      timedOut: false
    })
  })

  it('stores the filtered form and drops null lines', () => {
    const lines = createWorkflowStdoutLines({
      maxBytes: 1024,
      storeLine: (line) => (line.startsWith('drop') ? null : line.toUpperCase())
    })
    lines.write('keep one\ndrop this\nkeep two\n')
    expect(lines.result(captured()).stdout).toBe('KEEP ONE\nKEEP TWO\n')
  })

  it('reports its own overflow, not the raw capture limit', () => {
    const small = createWorkflowStdoutLines({ maxBytes: 16, storeLine: (line) => line.slice(0, 4) })
    small.write(`${'x'.repeat(4096)}\n${'y'.repeat(4096)}\n`)
    // The raw capture overflowed, but the stored form fits.
    const fits = small.result(captured({ stdoutTruncated: true }))
    expect(fits.stdout).toBe('xxxx\nyyyy\n')
    expect(fits.stdoutTruncated).toBeUndefined()
    const overflow = createWorkflowStdoutLines({ maxBytes: 8, storeLine: (line) => line })
    overflow.write('123456\n789\nlast\n')
    expect(overflow.result(captured())).toMatchObject({ stdout: '123456\n', stdoutTruncated: true })
  })

  it('keeps storing when the live observer throws', () => {
    const lines = createWorkflowStdoutLines({
      maxBytes: 64,
      storeLine: (line) => line,
      onLine: () => {
        throw new Error('observer failed')
      }
    })
    lines.write('a\nb\n')
    expect(lines.result(captured()).stdout).toBe('a\nb\n')
  })
})
