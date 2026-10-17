import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HANDOFF_FILE_MAX_BYTES,
  HANDOFF_THREAD_FILE_MAX_BYTES
} from '../../shared/console-handoff-contract'
import { captureHandoffAttachment } from './handoff-attachment-capture'
import { createHandoffAttachmentIo } from './handoff-attachment-source'

const roots: string[] = []

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'handoff-attachment-test-')))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function archiveEntries(contentBase64: string) {
  const tar = gunzipSync(Buffer.from(contentBase64, 'base64'))
  const result = new Map<string, { type: string; bytes: Buffer; mode: number }>()
  const field = (header: Buffer, start: number, end: number) =>
    header.subarray(start, end).toString('utf8').replace(/\0.*$/, '')
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      break
    }
    expect(field(header, 257, 263)).toBe('ustar')
    const name = field(header, 0, 100)
    const prefix = field(header, 345, 500)
    const size = Number.parseInt(field(header, 124, 136), 8)
    const path = prefix ? `${prefix}/${name}` : name
    result.set(path, {
      type: field(header, 156, 157),
      bytes: tar.subarray(offset + 512, offset + 512 + size),
      mode: Number.parseInt(field(header, 100, 108), 8)
    })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return result
}

describe('selected handoff attachments', () => {
  it('reads a large regular file once only for an opted-in thread upload', async () => {
    const path = join(await fixture(), 'large.bin')
    const bytes = Buffer.alloc(HANDOFF_THREAD_FILE_MAX_BYTES, 42)
    await writeFile(path, bytes)
    const source = createHandoffAttachmentIo()
    let reads = 0
    const io = {
      ...source,
      readExact: async (...args: Parameters<typeof source.readExact>) => {
        reads += 1
        return source.readExact(...args)
      }
    }
    await expect(captureHandoffAttachment(path, io)).rejects.toThrow('10 MiB')
    expect(reads).toBe(0)
    const file = await captureHandoffAttachment(path, io, true)
    expect(file.size).toBe(bytes.length)
    expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(reads).toBe(1)
    await writeFile(path, Buffer.alloc(HANDOFF_THREAD_FILE_MAX_BYTES + 1))
    await expect(captureHandoffAttachment(path, io, true)).rejects.toThrow('25 MiB')
    expect(reads).toBe(1)
  })

  it.each([
    ['plan.md', Buffer.from('# Plan\r\n\r\nPreserve this text.\r\n')],
    ['preview.html', Buffer.from('<!doctype html><h1>Local preview</h1>')],
    ['original.bin', Buffer.from([0, 128, 255, 10, 0])],
    ['empty.txt', Buffer.alloc(0)]
  ])('keeps the original name and exact bytes of %s', async (name, bytes) => {
    const path = join(await fixture(), name)
    await writeFile(path, bytes)
    const attachment = await captureHandoffAttachment(path)
    expect(attachment).toEqual({
      name,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentBase64: bytes.toString('base64')
    })
  })

  it('archives hierarchy, same-basename files, hidden files and empty folders without changing bytes', async () => {
    const root = join(await fixture(), 'Project files')
    await mkdir(join(root, 'nested', 'empty'), { recursive: true })
    await writeFile(join(root, '.hidden'), 'included')
    await writeFile(join(root, 'plan.md'), '# Main plan\n')
    await writeFile(join(root, 'nested', 'plan.md'), '# Nested plan\r\n')
    await writeFile(join(root, 'nested', 'raw.bin'), Buffer.from([0, 255, 128]))
    const executable = join(root, 'run.sh')
    await writeFile(executable, '#!/bin/sh\ntrue\n')
    if (process.platform !== 'win32') {
      await chmod(executable, 0o755)
    }
    const first = await captureHandoffAttachment(root)
    const second = await captureHandoffAttachment(root)
    expect(first.name).toBe('Project files.tar.gz')
    expect(second).toEqual(first)
    const entries = archiveEntries(first.contentBase64)
    expect([...entries.keys()]).toEqual([
      'Project files',
      'Project files/.hidden',
      'Project files/nested',
      'Project files/nested/empty',
      'Project files/nested/plan.md',
      'Project files/nested/raw.bin',
      'Project files/plan.md',
      'Project files/run.sh'
    ])
    expect(entries.get('Project files/nested/empty')).toMatchObject({
      type: '5',
      bytes: Buffer.alloc(0)
    })
    expect(entries.get('Project files/nested/raw.bin')?.bytes).toEqual(Buffer.from([0, 255, 128]))
    expect(entries.get('Project files/nested/plan.md')?.bytes.toString()).toBe('# Nested plan\r\n')
    expect(entries.get('Project files/.hidden')?.bytes.toString()).toBe('included')
    if (process.platform !== 'win32') {
      expect(entries.get('Project files/run.sh')?.mode).toBe(0o755)
    }
  })

  it('returns a usable archive for an empty selected folder', async () => {
    const root = join(await fixture(), 'empty')
    await mkdir(root)
    const file = await captureHandoffAttachment(root)
    expect([...archiveEntries(file.contentBase64).entries()]).toEqual([
      ['empty', { type: '5', bytes: Buffer.alloc(0), mode: 0o755 }]
    ])
  })

  it('refuses oversized files and folder overhead before reading file content', async () => {
    const root = join(await fixture(), 'large')
    await mkdir(root)
    const path = join(root, 'payload.bin')
    await writeFile(path, Buffer.alloc(HANDOFF_FILE_MAX_BYTES + 1))
    await expect(captureHandoffAttachment(path)).rejects.toThrow('10 MiB')
    await writeFile(path, Buffer.alloc(HANDOFF_FILE_MAX_BYTES))
    let reads = 0
    const io = createHandoffAttachmentIo()
    await expect(
      captureHandoffAttachment(root, {
        ...io,
        readExact: async (...args) => {
          reads += 1
          return io.readExact(...args)
        }
      })
    ).rejects.toThrow('10 MiB')
    expect(reads).toBe(0)
  })

  it('refuses a folder changed after a file was captured', async () => {
    const root = join(await fixture(), 'mutable')
    await mkdir(root)
    await writeFile(join(root, 'plan.md'), 'before')
    const io = createHandoffAttachmentIo()
    await expect(
      captureHandoffAttachment(root, {
        ...io,
        readExact: async (...args) => {
          const bytes = await io.readExact(...args)
          await writeFile(join(root, 'added.md'), 'must not be silently omitted')
          return bytes
        }
      })
    ).rejects.toThrow('changed')
  })

  it.skipIf(process.platform === 'win32')(
    'refuses links inside the folder and a selected link',
    async () => {
      const parent = await fixture()
      const root = join(parent, 'chosen')
      await mkdir(root)
      await writeFile(join(parent, 'outside.md'), 'outside the selected folder')
      await symlink(join(parent, 'outside.md'), join(root, 'link.md'))
      await expect(captureHandoffAttachment(root)).rejects.toThrow('symbolic links')
      await expect(captureHandoffAttachment(join(root, 'link.md'))).rejects.toThrow(
        'symbolic links'
      )
    }
  )
})
