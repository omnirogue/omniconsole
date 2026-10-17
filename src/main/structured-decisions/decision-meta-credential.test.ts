import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAcmeMetaCredential, resolveTypesafeCredential } from './decision-credential'

vi.mock('node:fs/promises', () => ({ open: vi.fn() }))
const TOKEN = 'acme_meta_fixture_token_123456789'
const TYPESAFE = 'typesafe_fixture_key_123456789'
const PATH = join(tmpdir(), 'fixture-vault', 'connections.env')

function vault(text: string) {
  const contents = Buffer.from(text)
  const file = {
    stat: vi.fn(async () => ({ isFile: () => true, mode: 0o100600, size: contents.length })),
    read: vi.fn(async (buffer: Buffer) => ({ bytesRead: contents.copy(buffer), buffer })),
    close: vi.fn(async () => undefined)
  }
  vi.mocked(open).mockResolvedValue(file as unknown as FileHandle)
  return file
}
beforeEach(() => vi.clearAllMocks())

describe('fixed local Meta credential reader', () => {
  it('reads only each explicitly named credential from the central literal vault', async () => {
    const file = vault(`TYPESAFE_API_KEY=${TYPESAFE}\nACME_META_ACCESS_TOKEN='${TOKEN}'`)
    await expect(resolveAcmeMetaCredential({}, PATH)).resolves.toBe(TOKEN)
    await expect(resolveTypesafeCredential({}, PATH)).resolves.toBe(TYPESAFE)
    expect(file.close).toHaveBeenCalledTimes(2)
  })

  it('uses a literal environment override without opening a file', async () => {
    await expect(
      resolveAcmeMetaCredential({ ACME_META_ACCESS_TOKEN: ` ${TOKEN}\n` }, PATH)
    ).resolves.toBe(TOKEN)
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['short', 'contains spaces and characters', 'a'.repeat(4097), '$(read-secret)'])(
    'refuses an invalid override without falling through to the vault: %s',
    async (token) => {
      vault(`ACME_META_ACCESS_TOKEN=${TOKEN}`)
      await expect(
        resolveAcmeMetaCredential({ ACME_META_ACCESS_TOKEN: token }, PATH)
      ).resolves.toBeUndefined()
      expect(open).not.toHaveBeenCalled()
    }
  )

  it.each([
    `TYPESAFE_API_KEY=${TYPESAFE}`,
    `OMNIROGUE_META_ACCESS_TOKEN=${TOKEN}`,
    `ACME_META_ACCESS_TOKEN=${TOKEN}\nACME_META_ACCESS_TOKEN=${TOKEN}`,
    'ACME_META_ACCESS_TOKEN="$OTHER_TOKEN"',
    'ACME_META_ACCESS_TOKEN="$(credential-command)"',
    'ACME_META_ACCESS_TOKEN=`credential-command`',
    `ACME_META_ACCESS_TOKEN=${TOKEN}; command`,
    `ACME_META_ACCESS_TOKEN=${TOKEN} # comment`
  ])('never substitutes another credential or evaluates shell text: %s', async (text) => {
    const file = vault(text)
    await expect(resolveAcmeMetaCredential({}, PATH)).resolves.toBeUndefined()
    expect(file.close).toHaveBeenCalledOnce()
  })

  it('permits a longer Meta token without widening the TypeSafe credential grammar', async () => {
    const token = 'a'.repeat(4096)
    await expect(resolveAcmeMetaCredential({ ACME_META_ACCESS_TOKEN: token }, PATH)).resolves.toBe(
      token
    )
    await expect(
      resolveTypesafeCredential({ TYPESAFE_API_KEY: token }, PATH)
    ).resolves.toBeUndefined()
  })

  it('contains a vault error without returning its possibly sensitive message', async () => {
    const file = vault(`ACME_META_ACCESS_TOKEN=${TOKEN}`)
    file.read.mockRejectedValueOnce(new Error(`vault error containing ${TOKEN}`))
    await expect(resolveAcmeMetaCredential({}, PATH)).resolves.toBeUndefined()
    expect(file.close).toHaveBeenCalledOnce()
  })
})
