import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DecisionRecords } from './decision-records'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) }
})

const MAX_RECORD_BYTES = 512 * 1024
const recordSchema = z
  .object({
    version: z.literal(1),
    summary: z.string().trim().min(1),
    outcome: z.enum(['continue', 'stop'])
  })
  .strict()
const record = { version: 1, summary: 'Initial recommendation', outcome: 'continue' } as const
const replacement = { ...record, summary: 'Updated recommendation', outcome: 'stop' } as const
const textSchema = z.object({ text: z.string() }).strict()
let root: string
let directory: string
let records: DecisionRecords
let actualFs: typeof FsPromises

function filename(kind: 'result' | 'action', key: string): string {
  return `${kind}-${createHash('sha256').update(key).digest('hex')}.json`
}

beforeEach(async () => {
  actualFs = await vi.importActual<typeof FsPromises>('node:fs/promises')
  vi.mocked(rename).mockReset().mockImplementation(actualFs.rename)
  vi.mocked(open).mockReset().mockImplementation(actualFs.open)
  root = await mkdtemp(join(tmpdir(), 'omni-decision-records-'))
  directory = join(root, 'records')
  records = new DecisionRecords(directory)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('DecisionRecords validation', () => {
  it.each(['result', 'action'] as const)(
    'round-trips schema-parsed %s records across instances',
    async (kind) => {
      await records.write(
        kind,
        'run-1',
        { ...record, summary: '  Initial recommendation  ' },
        recordSchema
      )

      const persisted = JSON.parse(await readFile(join(directory, filename(kind, 'run-1')), 'utf8'))
      expect(persisted).toEqual(record)
      await expect(
        new DecisionRecords(directory).read(kind, 'run-1', recordSchema)
      ).resolves.toEqual(record)

      await writeFile(
        join(directory, filename(kind, 'run-1')),
        JSON.stringify({ ...record, summary: '  From disk  ' })
      )
      await expect(records.read(kind, 'run-1', recordSchema)).resolves.toEqual({
        ...record,
        summary: 'From disk'
      })
    }
  )

  it('returns null for missing records without creating the store', async () => {
    await expect(records.read('result', 'missing', recordSchema)).resolves.toBeNull()
    expect(open).toHaveBeenCalledWith(
      join(directory, filename('result', 'missing')),
      constants.O_RDONLY | constants.O_NONBLOCK
    )
    expect(await readdir(root)).toEqual([])
  })

  it('rejects invalid writes before creating files and preserves an existing valid record', async () => {
    const invalid = { ...record, summary: '   ' }
    await expect(records.write('result', 'run-1', invalid, recordSchema)).rejects.toThrow()
    expect(await readdir(root)).toEqual([])

    await records.write('result', 'run-1', record, recordSchema)
    await expect(records.write('result', 'run-1', invalid, recordSchema)).rejects.toThrow()
    await expect(records.read('result', 'run-1', recordSchema)).resolves.toEqual(record)
    expect(await readdir(directory)).toEqual([filename('result', 'run-1')])
  })

  it.each([
    ['empty file', ''],
    ['truncated JSON', '{"version":1'],
    ['null', 'null'],
    ['array', '[]'],
    ['wrong version', JSON.stringify({ ...record, version: 2 })],
    ['missing field', JSON.stringify({ version: 1, summary: 'Incomplete' })],
    ['wrong field type', JSON.stringify({ ...record, summary: 7 })],
    ['unknown field', JSON.stringify({ ...record, rendererApproved: true })]
  ])('returns null for %s without altering the source', async (_label, content) => {
    await mkdir(directory)
    const target = join(directory, filename('result', 'run-1'))
    await writeFile(target, content)

    await expect(records.read('result', 'run-1', recordSchema)).resolves.toBeNull()
    expect(await readFile(target, 'utf8')).toBe(content)
    expect(await readdir(directory)).toEqual([basename(target)])
  })

  it('returns null when the record path is a directory', async () => {
    const target = join(directory, filename('result', 'run-1'))
    await mkdir(target, { recursive: true })

    await expect(records.read('result', 'run-1', recordSchema)).resolves.toBeNull()
    expect((await stat(target)).isDirectory()).toBe(true)
  })

  it('accepts exactly 512 KiB and rejects a one-byte-larger replacement', async () => {
    const text = 'x'.repeat(MAX_RECORD_BYTES - Buffer.byteLength(JSON.stringify({ text: '' })))
    const value = { text }
    await records.write('result', 'limit', value, textSchema)
    expect((await stat(join(directory, filename('result', 'limit')))).size).toBe(MAX_RECORD_BYTES)
    await expect(records.read('result', 'limit', textSchema)).resolves.toEqual(value)

    await expect(
      records.write('result', 'limit', { text: `${text}x` }, textSchema)
    ).rejects.toThrow('Structured decision record exceeds its size limit.')
    await expect(records.read('result', 'limit', textSchema)).resolves.toEqual(value)
    expect(await readdir(directory)).toEqual([filename('result', 'limit')])
  })

  it('enforces bytes rather than character count before creating the store', async () => {
    const value = { text: '😀'.repeat(MAX_RECORD_BYTES / 4) }
    expect(JSON.stringify(value).length).toBeLessThan(MAX_RECORD_BYTES)
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(MAX_RECORD_BYTES)

    await expect(records.write('result', 'unicode', value, textSchema)).rejects.toThrow(
      /size limit/
    )
    expect(await readdir(root)).toEqual([])
  })

  it('rejects oversized but otherwise valid JSON already on disk', async () => {
    await mkdir(directory)
    const target = join(directory, filename('result', 'oversized'))
    const content = JSON.stringify({ text: 'x'.repeat(MAX_RECORD_BYTES) })
    await writeFile(target, content)

    await expect(records.read('result', 'oversized', textSchema)).resolves.toBeNull()
    expect(await readFile(target, 'utf8')).toBe(content)
  })

  it('bounds reads and closes the handle when a record grows beyond its reported size', async () => {
    await mkdir(directory)
    const target = join(directory, filename('result', 'growing'))
    await writeFile(target, JSON.stringify({ text: 'x'.repeat(MAX_RECORD_BYTES) }))
    const file = await actualFs.open(target, 'r')
    const originalStat = file.stat.bind(file)
    vi.spyOn(file, 'stat').mockImplementationOnce(async () =>
      Object.assign(await originalStat(), { size: 1 })
    )
    const read = vi.spyOn(file, 'read')
    vi.mocked(open).mockResolvedValueOnce(file)

    await expect(records.read('result', 'growing', textSchema)).resolves.toBeNull()

    expect(read).toHaveBeenCalledWith(expect.any(Buffer), 0, MAX_RECORD_BYTES + 1, 0)
    expect(file.fd).toBe(-1)
  })

  it('rejects a short read containing valid JSON when the file has unread trailing corruption', async () => {
    await mkdir(directory)
    const target = join(directory, filename('result', 'short-read'))
    const prefix = Buffer.from(JSON.stringify(record))
    await writeFile(target, `${prefix.toString('utf8')} trailing corruption`)
    const file = await actualFs.open(target, 'r')
    expect((await file.stat()).size).toBeGreaterThan(prefix.length)
    const shortRead = vi.fn(async (buffer: Buffer, offset: number) => ({
      bytesRead: prefix.copy(buffer, offset),
      buffer
    }))
    vi.spyOn(file, 'read').mockImplementationOnce(shortRead as unknown as typeof file.read)
    vi.mocked(open).mockResolvedValueOnce(file)

    await expect(records.read('result', 'short-read', recordSchema)).resolves.toBeNull()

    expect(shortRead).toHaveBeenCalledOnce()
    expect(file.fd).toBe(-1)
  })
})

describe('DecisionRecords storage boundaries', () => {
  it('hashes traversal and absolute keys into files under the main-owned directory', async () => {
    const outside = join(root, 'outside.json')
    await writeFile(outside, 'untouched sibling')
    const keys = [
      '../outside.json',
      '..\\outside.json',
      outside,
      'private/run-1',
      '\0../outside.json'
    ]

    for (const key of keys) {
      await records.write('result', key, record, recordSchema)
      await expect(records.read('result', key, recordSchema)).resolves.toEqual(record)
    }

    const entries = await readdir(directory)
    expect(entries.sort()).toEqual(keys.map((key) => filename('result', key)).sort())
    for (const entry of entries) {
      expect(entry).toMatch(/^result-[a-f0-9]{64}\.json$/)
    }
    expect((await readdir(root)).sort()).toEqual(['outside.json', 'records'])
    expect(await readFile(outside, 'utf8')).toBe('untouched sibling')
  })

  it('isolates action and result records and distinct keys', async () => {
    await records.write('result', 'run-1', record, recordSchema)
    await expect(records.read('action', 'run-1', recordSchema)).resolves.toBeNull()
    await expect(records.read('result', 'run-2', recordSchema)).resolves.toBeNull()

    await records.write('action', 'run-1', replacement, recordSchema)
    await records.write('result', 'run-2', { ...record, summary: 'Second run' }, recordSchema)
    await expect(records.read('result', 'run-1', recordSchema)).resolves.toEqual(record)
    await expect(records.read('action', 'run-1', recordSchema)).resolves.toEqual(replacement)
    await expect(records.read('result', 'run-2', recordSchema)).resolves.toEqual({
      ...record,
      summary: 'Second run'
    })
    expect(await readdir(directory)).toHaveLength(3)
  })

  it.skipIf(process.platform === 'win32')(
    'creates owner-only storage and replaces permissive files privately',
    async () => {
      await chmod(root, 0o755)
      await records.write('result', 'run-1', record, recordSchema)
      const target = join(directory, filename('result', 'run-1'))
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(target)).mode & 0o777).toBe(0o600)

      await chmod(target, 0o644)
      await records.write('result', 'run-1', replacement, recordSchema)
      expect((await stat(target)).mode & 0o777).toBe(0o600)
    }
  )
})

describe('DecisionRecords atomic replacement', () => {
  it('syncs and closes the temporary file before publishing, then syncs the directory', async () => {
    const events: string[] = []
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await actualFs.open(...args)
      const kind = args[0] === directory ? 'directory' : 'file'
      const originalSync = file.sync.bind(file)
      const originalClose = file.close.bind(file)
      vi.spyOn(file, 'sync').mockImplementationOnce(async () => {
        events.push(`${kind}:sync`)
        await originalSync()
      })
      vi.spyOn(file, 'close').mockImplementationOnce(async () => {
        await originalClose()
        events.push(`${kind}:close`)
      })
      return file
    })
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      events.push('rename')
      await actualFs.rename(source, destination)
    })

    await records.write('result', 'run-1', record, recordSchema)

    expect(events).toEqual([
      'file:sync',
      'file:close',
      'rename',
      ...(process.platform === 'win32' ? [] : ['directory:sync', 'directory:close'])
    ])
    expect(await readdir(directory)).toEqual([filename('result', 'run-1')])
  })

  it('keeps the old record readable until the complete temporary file is renamed', async () => {
    await records.write('result', 'run-1', record, recordSchema)
    const target = join(directory, filename('result', 'run-1'))
    let observedReplacement = false
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      observedReplacement = true
      expect(destination).toBe(target)
      expect(dirname(String(source))).toBe(directory)
      expect(basename(String(source))).toMatch(/^result-[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/)
      expect(JSON.parse(await readFile(source, 'utf8'))).toEqual(replacement)
      await expect(records.read('result', 'run-1', recordSchema)).resolves.toEqual(record)
      expect(await readdir(directory)).toHaveLength(2)
      if (process.platform !== 'win32') {
        expect((await stat(source)).mode & 0o777).toBe(0o600)
      }
      await actualFs.rename(source, destination)
    })

    await records.write('result', 'run-1', replacement, recordSchema)

    expect(observedReplacement).toBe(true)
    await expect(records.read('result', 'run-1', recordSchema)).resolves.toEqual(replacement)
    expect(await readdir(directory)).toEqual([basename(target)])
  })

  it.each(['partial write', 'file sync', 'rename'] as const)(
    'preserves the old record and removes temporary files after a failed %s',
    async (phase) => {
      await records.write('action', 'decision-1', record, recordSchema)
      const failure = new Error(`Simulated ${phase} failure`)
      let failedFile: Awaited<ReturnType<typeof open>> | undefined
      if (phase === 'rename') {
        vi.mocked(rename).mockRejectedValueOnce(failure)
      } else {
        vi.mocked(open).mockImplementationOnce(async (...args) => {
          const file = await actualFs.open(...args)
          failedFile = file
          if (phase === 'partial write') {
            const originalWrite = file.writeFile.bind(file)
            vi.spyOn(file, 'writeFile').mockImplementationOnce(async () => {
              await originalWrite('{"partial":')
              throw failure
            })
          } else {
            vi.spyOn(file, 'sync').mockRejectedValueOnce(failure)
          }
          return file
        })
      }

      await expect(records.write('action', 'decision-1', replacement, recordSchema)).rejects.toBe(
        failure
      )

      if (phase !== 'rename') {
        expect(failedFile?.fd).toBe(-1)
      }
      await expect(records.read('action', 'decision-1', recordSchema)).resolves.toEqual(record)
      expect(await readdir(directory)).toEqual([filename('action', 'decision-1')])
      await records.write('action', 'decision-1', replacement, recordSchema)
      await expect(records.read('action', 'decision-1', recordSchema)).resolves.toEqual(replacement)
      expect(await readdir(directory)).toEqual([filename('action', 'decision-1')])
    }
  )
})
