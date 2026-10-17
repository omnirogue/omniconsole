import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { packWakeCopy, unpackWakeCopy, type WakeCopyHeader } from './review-wake-copy-pack'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wake-copy-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

function source(): { header: Omit<WakeCopyHeader, 'written'>; conversation: Map<string, string> } {
  mkdirSync(join(dir, 'src', 'conv-1', 'subagents'), { recursive: true })
  writeFileSync(join(dir, 'src', 'conv-1.jsonl'), '{"a":1}\n')
  writeFileSync(join(dir, 'src', 'conv-1', 'subagents', 's.jsonl'), '{"b":2}\n')
  writeFileSync(join(dir, 'src', 'hello.txt'), 'hello')
  return {
    header: {
      version: 1,
      slug: 'plan',
      revision: 2,
      provider: 'claude',
      sessionId: 'conv-1',
      title: 'Plan',
      model: 'opus',
      effort: 'high',
      writerVersion: '2.1.3',
      host: 'MacBook',
      workspace: { kind: 'folder', workRelativePath: 'Ops/X' },
      manifest: {
        version: 1,
        provider: 'claude',
        providerSessionId: 'conv-1',
        files: [
          { path: 'conv-1.jsonl', bytes: 8, sha256: sha('{"a":1}\n') },
          { path: 'conv-1/subagents/s.jsonl', bytes: 8, sha256: sha('{"b":2}\n') }
        ],
        digest: 'd'
      }
    },
    conversation: new Map([
      ['conv-1.jsonl', join(dir, 'src', 'conv-1.jsonl')],
      ['conv-1/subagents/s.jsonl', join(dir, 'src', 'conv-1', 'subagents', 's.jsonl')]
    ])
  }
}

describe('the wake copy container', () => {
  it('round-trips the conversation and written files, checked byte for byte', async () => {
    const input = source()
    const packed = await packWakeCopy({
      ...input,
      written: [{ path: 'notes/hello.txt', absolute: join(dir, 'src', 'hello.txt') }]
    })
    const out = join(dir, 'out')
    const unpacked = await unpackWakeCopy(packed.blob, packed.sha256, out)
    expect(unpacked.header).toMatchObject({
      slug: 'plan',
      model: 'opus',
      written: [{ path: 'notes/hello.txt' }]
    })
    expect(readFileSync(join(out, 'bundle', 'conv-1', 'subagents', 's.jsonl'), 'utf8')).toBe(
      '{"b":2}\n'
    )
    expect(readFileSync(join(out, 'written', 'notes', 'hello.txt'), 'utf8')).toBe('hello')
  })

  it('refuses a copy whose checksum or contents do not match', async () => {
    const packed = await packWakeCopy({ ...source(), written: [] })
    await expect(unpackWakeCopy(packed.blob, 'f'.repeat(64), join(dir, 'a'))).rejects.toThrow(
      /checksum/
    )
    const raw = Buffer.from(gzipSync(Buffer.concat([Buffer.from('nope')])))
    await expect(
      unpackWakeCopy(raw, createHash('sha256').update(raw).digest('hex'), join(dir, 'b'))
    ).rejects.toThrow(/not a wake copy/)
  })

  it('never writes outside its staging folder or a credential-shaped file', async () => {
    for (const path of [
      '../escape.txt',
      '.env',
      'keys/id_rsa',
      'notes/con.txt',
      'a:stream',
      'dir./x'
    ]) {
      const input = source()
      const packed = await packWakeCopy({
        ...input,
        written: [{ path, absolute: join(dir, 'src', 'hello.txt') }]
      })
      await expect(
        unpackWakeCopy(packed.blob, packed.sha256, join(dir, 'c', path.length.toString()))
      ).rejects.toThrow(/unsafe file/)
    }
  })

  it('refuses a conversation file that changed while it was being copied', async () => {
    const input = source()
    writeFileSync(join(dir, 'src', 'conv-1.jsonl'), '{"a":2}\n')
    await expect(packWakeCopy({ ...input, written: [] })).rejects.toThrow(/changed/)
  })

  it('writes nothing when any part of the copy is damaged', async () => {
    const input = source()
    const packed = await packWakeCopy({
      ...input,
      written: [{ path: 'notes/hello.txt', absolute: join(dir, 'src', 'hello.txt') }]
    })
    const { gunzipSync, gzipSync: zip } = await import('node:zlib')
    const raw = gunzipSync(packed.blob)
    raw[raw.length - 1] = raw.at(-1)! ^ 1
    const broken = zip(raw)
    const out = join(dir, 'broken')
    await expect(
      unpackWakeCopy(broken, createHash('sha256').update(broken).digest('hex'), out)
    ).rejects.toThrow(/damaged/)
    expect(() => readFileSync(join(out, 'bundle', 'conv-1.jsonl'))).toThrow()
  })
})
