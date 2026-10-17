import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveTypesafeCredential, resolveOpenRouterCredential } from './decision-credential'

vi.mock('node:fs/promises', () => ({ open: vi.fn() }))

const FIXTURE_KEY = 'typesafe_fixture_key_123456789'
const FIXTURE_VAULT = join(tmpdir(), 'typesafe-test-vault', 'connections.env')
const MAX_VAULT_BYTES = 1024 * 1024
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

function vault(text = `TYPESAFE_API_KEY=${FIXTURE_KEY}`) {
  const contents = Buffer.from(text)
  const metadata = { isFile: () => true, mode: 0o100600, size: contents.length }
  let cursor = 0
  const file = {
    stat: vi.fn().mockResolvedValue(metadata),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number | null) => {
      const start = position ?? cursor
      const bytesRead = contents.copy(
        buffer,
        offset,
        start,
        Math.min(start + length, contents.length)
      )
      cursor = start + bytesRead
      return { bytesRead, buffer }
    }),
    close: vi.fn().mockResolvedValue(undefined)
  }
  vi.mocked(open).mockImplementation(async () => {
    cursor = 0
    return file as unknown as FileHandle
  })
  return { file, metadata }
}

beforeEach(() => {
  vi.mocked(open).mockReset()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.restoreAllMocks()
})

describe('resolveTypesafeCredential', () => {
  it('uses an explicit trimmed key without opening the vault', async () => {
    await expect(
      resolveTypesafeCredential({ TYPESAFE_API_KEY: `  ${FIXTURE_KEY}\n` }, FIXTURE_VAULT)
    ).resolves.toBe(FIXTURE_KEY)
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['too-short', 'a'.repeat(513), 'invalid key with spaces', 'invalid.key.with.dots'])(
    'refuses malformed explicit credentials without falling back to the vault: %j',
    async (key) => {
      vault()
      await expect(
        resolveTypesafeCredential({ TYPESAFE_API_KEY: key }, FIXTURE_VAULT)
      ).resolves.toBeUndefined()
      expect(open).not.toHaveBeenCalled()
    }
  )

  it.each([16, 512])(
    'accepts an explicit credential at the %i-character boundary',
    async (size) => {
      const key = 'a'.repeat(size)
      await expect(
        resolveTypesafeCredential({ TYPESAFE_API_KEY: key }, FIXTURE_VAULT)
      ).resolves.toBe(key)
      expect(open).not.toHaveBeenCalled()
    }
  )

  it.each([
    `TYPESAFE_API_KEY=${FIXTURE_KEY}`,
    `TYPESAFE_API_KEY='${FIXTURE_KEY}'`,
    `export TYPESAFE_API_KEY = "${FIXTURE_KEY}"\r\n`,
    `# TYPESAFE_API_KEY=ignored_comment\nOTHER_API_KEY=unrelated_fixture_secret\nTYPESAFE_API_KEY=${FIXTURE_KEY}`
  ])('extracts only the provider credential from a supported literal assignment', async (text) => {
    const { file } = vault(text)

    await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBe(FIXTURE_KEY)

    expect(open).toHaveBeenCalledExactlyOnceWith(
      FIXTURE_VAULT,
      constants.O_RDONLY | constants.O_NONBLOCK
    )
    expect(file.read).toHaveBeenCalled()
    for (const [, offset, length] of file.read.mock.calls) {
      expect(offset + length).toBeLessThanOrEqual(MAX_VAULT_BYTES + 1)
    }
    expect(file.close).toHaveBeenCalledTimes(1)
  })

  it.each(['', '  '])(
    'uses the vault when the explicit environment value is empty',
    async (key) => {
      vault()
      await expect(
        resolveTypesafeCredential({ TYPESAFE_API_KEY: key }, FIXTURE_VAULT)
      ).resolves.toBe(FIXTURE_KEY)
    }
  )

  it('does not log credential contents or vault errors', async () => {
    const logs = (['debug', 'info', 'log', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined)
    )
    const { file } = vault(
      `OTHER_API_KEY=unrelated_fixture_secret\nTYPESAFE_API_KEY=${FIXTURE_KEY}`
    )
    await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBe(FIXTURE_KEY)

    file.read.mockRejectedValueOnce(new Error(`fixture error containing ${FIXTURE_KEY}`))
    await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBeUndefined()

    for (const log of logs) {
      expect(log).not.toHaveBeenCalled()
    }
    expect(file.close).toHaveBeenCalledTimes(2)
  })

  it.each([
    `TYPESAFE_API_KEY="$(printf ${FIXTURE_KEY})"`,
    `TYPESAFE_API_KEY=\`printf ${FIXTURE_KEY}\``,
    'TYPESAFE_API_KEY="$OTHER_API_KEY"',
    `TYPESAFE_API_KEY=${FIXTURE_KEY}; printf ignored`,
    `TYPESAFE_API_KEY=${FIXTURE_KEY} # trailing shell comment`
  ])('rejects shell expressions rather than evaluating them', async (text) => {
    const { file } = vault(text)

    await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBeUndefined()
    expect(file.close).toHaveBeenCalledTimes(1)
  })

  it('ignores shell text outside the one literal credential entry', async () => {
    vault(
      `throw-not-a-shell-command\nOTHER_API_KEY="$(printf unrelated)"\nTYPESAFE_API_KEY=${FIXTURE_KEY}`
    )
    await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBe(FIXTURE_KEY)
  })

  it.each([
    '',
    'OTHER_API_KEY=unrelated_fixture_secret',
    '# TYPESAFE_API_KEY=commented_fixture_key',
    `TYPESAFE_API_KEY=${FIXTURE_KEY}\nTYPESAFE_API_KEY=${FIXTURE_KEY}`,
    `TYPESAFE_API_KEY=${FIXTURE_KEY}\nexport TYPESAFE_API_KEY=another_fixture_key`,
    'TYPESAFE_API_KEY=',
    'TYPESAFE_API_KEY=short',
    `TYPESAFE_API_KEY='${FIXTURE_KEY}"`,
    `TYPESAFE_API_KEY=${'a'.repeat(513)}`
  ])('fails closed for missing, duplicate, or malformed entries', async (text) => {
    const { file } = vault(text)
    await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBeUndefined()
    expect(file.close).toHaveBeenCalledTimes(1)
  })

  it.each(['ENOENT', 'EACCES'])(
    'fails closed when the vault cannot be opened: %s',
    async (code) => {
      vi.mocked(open).mockRejectedValueOnce(
        Object.assign(new Error('fixture vault unavailable'), { code })
      )
      await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBeUndefined()
    }
  )

  it.each([0o100640, 0o100604, 0o100610, 0o100601])(
    'rejects group or other access before reading a POSIX vault: %o',
    async (mode) => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      const { file, metadata } = vault()
      metadata.mode = mode

      await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBeUndefined()

      expect(file.read).not.toHaveBeenCalled()
      expect(file.close).toHaveBeenCalledTimes(1)
    }
  )

  it('does not interpret Windows mode bits as POSIX permissions', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const { metadata } = vault()
    metadata.mode = 0o100666

    await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBe(FIXTURE_KEY)
  })

  it('rejects an oversized vault before loading its contents', async () => {
    const { file, metadata } = vault()
    metadata.size = MAX_VAULT_BYTES + 1

    await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBeUndefined()

    expect(file.read).not.toHaveBeenCalled()
    expect(file.close).toHaveBeenCalledTimes(1)
  })

  it('accepts a vault at the one MiB boundary', async () => {
    vault(`TYPESAFE_API_KEY=${FIXTURE_KEY}\n#`.padEnd(MAX_VAULT_BYTES, 'x'))
    await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBe(FIXTURE_KEY)
  })

  it('rejects content that grows beyond the size limit after the metadata check', async () => {
    const { file, metadata } = vault(
      `TYPESAFE_API_KEY=${FIXTURE_KEY}\n#`.padEnd(MAX_VAULT_BYTES + 1, 'x')
    )
    metadata.size = 64

    await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBeUndefined()

    expect(file.read).toHaveBeenCalled()
    expect(file.close).toHaveBeenCalledTimes(1)
  })

  it('rejects a short read that omits a duplicate credential in the remaining bytes', async () => {
    const prefix = `TYPESAFE_API_KEY=${FIXTURE_KEY}\n`
    const { file } = vault(`${prefix}TYPESAFE_API_KEY=another_fixture_key`)
    file.read.mockImplementationOnce(async (buffer, offset, length) => {
      const bytesRead = buffer.write(prefix, offset, Math.min(length, Buffer.byteLength(prefix)))
      return { bytesRead, buffer }
    })

    await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBeUndefined()

    expect(file.close).toHaveBeenCalledTimes(1)
  })

  it('rejects an opened nonregular file before reading it', async () => {
    const { file, metadata } = vault()
    metadata.isFile = () => false

    await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBeUndefined()

    expect(file.read).not.toHaveBeenCalled()
    expect(file.close).toHaveBeenCalledTimes(1)
  })

  it.each(['stat', 'read'] as const)('closes the vault after a %s error', async (operation) => {
    const { file } = vault()
    file[operation].mockRejectedValueOnce(new Error('fixture I/O failure'))

    await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBeUndefined()
    expect(file.close).toHaveBeenCalledTimes(1)
  })

  it('contains a close failure without leaking the error or losing a valid result', async () => {
    const { file } = vault()
    file.close.mockRejectedValueOnce(new Error('fixture close failure'))
    await expect(resolveTypesafeCredential({}, FIXTURE_VAULT)).resolves.toBe(FIXTURE_KEY)
  })
})

it('reads OpenRouter from the private literal vault and prefers the environment', async () => {
  vault('OPENROUTER_API_KEY=sk-or-test_key_123456789')
  expect(await resolveOpenRouterCredential({}, FIXTURE_VAULT)).toBe('sk-or-test_key_123456789')
  expect(
    await resolveOpenRouterCredential(
      { OPENROUTER_API_KEY: 'sk-or-env_key_123456789' },
      FIXTURE_VAULT
    )
  ).toBe('sk-or-env_key_123456789')
  const { metadata } = vault('OPENROUTER_API_KEY=sk-or-test_key_123456789')
  metadata.mode = 0o100644
  if (process.platform !== 'win32') {
    expect(await resolveOpenRouterCredential({}, FIXTURE_VAULT)).toBeUndefined()
  }
})
