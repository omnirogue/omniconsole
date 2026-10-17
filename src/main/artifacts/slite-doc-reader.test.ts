import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSliteDoc, sliteApiKey } from './slite-doc-reader'

describe('sliteApiKey', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'slite-key-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('prefers the environment, then slite-kb’s key file, then the private vault', () => {
    expect(sliteApiKey({ SLITE_API_KEY: ' env ' }, home, 'darwin')).toBe('env')
    mkdirSync(join(home, '.config', 'omni'), { recursive: true })
    const vault = join(home, '.config', 'omni', 'connections.env')
    writeFileSync(vault, 'OTHER=1\nexport OMNIROGUE_SLITE_API_KEY="vault-key"\n')
    chmodSync(vault, 0o600)
    expect(sliteApiKey({}, home, 'darwin')).toBe('vault-key')
    mkdirSync(join(home, '.config', 'slite-kb'), { recursive: true })
    const own = join(home, '.config', 'slite-kb', 'api-key')
    writeFileSync(own, 'own-key\n')
    chmodSync(own, 0o600)
    expect(sliteApiKey({}, home, 'darwin')).toBe('own-key')
  })

  it('never reads a key file others can read', () => {
    mkdirSync(join(home, '.config', 'slite-kb'), { recursive: true })
    const own = join(home, '.config', 'slite-kb', 'api-key')
    writeFileSync(own, 'own-key')
    chmodSync(own, 0o644)
    expect(sliteApiKey({}, home, 'darwin')).toBeUndefined()
  })
})

describe('readSliteDoc', () => {
  it('returns the doc as Markdown and sends the key only to Slite', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        title: 'PLAN · Launch',
        content: '- [ ] first\n- [x] done',
        url: 'https://example.slite.com/api/s/AAAAAAAAAAAAAA/PLAN',
        lastEditedAt: '2026-09-23T13:14:43.018Z'
      })
    )
    const result = await readSliteDoc('AAAAAAAAAAAAAA', {
      key: () => 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1
    })
    expect(result).toMatchObject({
      status: 'ok',
      title: 'PLAN · Launch',
      markdown: '- [ ] first\n- [x] done',
      updatedAt: '2026-09-23T13:14:43.018Z'
    })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.slite.com/v1/notes/AAAAAAAAAAAAAA?format=md')
    expect((init.headers as Record<string, string>)['x-slite-api-key']).toBe('k')
  })

  it('says what is missing instead of failing', async () => {
    expect(await readSliteDoc('BBBBBBBBBBBBBB', { key: () => undefined })).toMatchObject({
      status: 'no-key'
    })
    expect(await readSliteDoc('../x', { key: () => 'k' })).toMatchObject({ status: 'error' })
    const notFound = vi.fn(async () => new Response('', { status: 404 }))
    expect(
      await readSliteDoc('CCCCCCCCCCCCCC', {
        key: () => 'k',
        fetchImpl: notFound as unknown as typeof fetch
      })
    ).toMatchObject({
      status: 'error',
      message: 'This Slite doc is not visible to your Slite account.'
    })
  })
})
