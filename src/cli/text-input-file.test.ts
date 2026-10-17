import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readTextInputFile } from './text-input-file'

let dir = ''

function stdin(chunks: string[], isTTY = false): void {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(
    Object.assign(Readable.from(chunks), { isTTY }) as unknown as typeof process.stdin
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-text-input-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('readTextInputFile', () => {
  it('reads a path relative to the invocation cwd, or an absolute one', async () => {
    writeFileSync(join(dir, 'brief.md'), 'Do the work.')
    await expect(readTextInputFile('brief.md', dir)).resolves.toBe('Do the work.')
    await expect(readTextInputFile(join(dir, 'brief.md'), '/elsewhere')).resolves.toBe(
      'Do the work.'
    )
  })

  it('reads stdin for -, and refuses an interactive stdin by its label', async () => {
    stdin(['first ', 'second'])
    await expect(readTextInputFile('-', dir)).resolves.toBe('first second')
    stdin([], true)
    await expect(readTextInputFile('-', dir, { label: 'body' })).rejects.toThrow(
      'stdin body requested but stdin is a TTY'
    )
  })

  it('caps the text in UTF-8 bytes for a file and for stdin', async () => {
    writeFileSync(join(dir, 'big.md'), 'é'.repeat(6))
    await expect(
      readTextInputFile('big.md', dir, { maxBytes: 11, tooLargeMessage: 'Too large.' })
    ).rejects.toThrow('Too large.')
    await expect(readTextInputFile('big.md', dir, { maxBytes: 12 })).resolves.toBe('é'.repeat(6))
    stdin(['12345', '67890'])
    await expect(readTextInputFile('-', dir, { label: 'brief', maxBytes: 8 })).rejects.toThrow(
      'The brief is over 8 bytes.'
    )
  })
})
