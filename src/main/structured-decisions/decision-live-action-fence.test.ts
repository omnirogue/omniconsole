import { constants, type Stats } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DECISION_KILL_ENV } from './decision-configuration'
import { assertDecisionLiveActionEnabled } from './decision-live-action-fence'

const filesystem = vi.hoisted(() => ({
  lstatSync: vi.fn(),
  openSync: vi.fn(),
  fstatSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn()
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  ...filesystem
}))

const PATH = 'fixture-profile/structured-decisions.json'
const ROUTINE = 'advertising-routine'
const REFUSAL = 'Structured advertising actions are disabled or unavailable.'
const PRIVATE_DETAIL = 'private-final-fence-fixture'
const configuration = {
  version: 1,
  enabled: true,
  killSwitch: false,
  capabilities: { 'advertising.routine': { mode: 'live' } },
  routines: { [ROUTINE]: { mode: 'live' } }
}
let contents: Buffer

function metadata(patch: Partial<Stats> = {}): Stats {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    mode: 0o100600,
    uid: process.getuid?.() ?? 0,
    dev: 1,
    ino: 2,
    size: contents.length,
    mtimeMs: 1,
    ctimeMs: 1,
    ...patch
  } as Stats
}

function setConfiguration(value: unknown) {
  contents = Buffer.from(JSON.stringify(value))
}

function assertEnabled() {
  assertDecisionLiveActionEnabled(PATH, ROUTINE)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv(DECISION_KILL_ENV, undefined)
  setConfiguration(configuration)
  filesystem.lstatSync.mockImplementation(() => metadata())
  filesystem.openSync.mockReturnValue(7)
  filesystem.fstatSync.mockImplementation(() => metadata())
  filesystem.readSync.mockImplementation(
    (_fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
      contents.copy(buffer, offset, position, position + length)
  )
})

afterEach(() => vi.unstubAllEnvs())

describe('synchronous live advertising action fence', () => {
  it('requires the live advertising capability and exact routine mode', () => {
    expect(assertEnabled).not.toThrow()
    expect(filesystem.openSync).toHaveBeenCalledWith(PATH, expect.any(Number))
    expect(filesystem.closeSync).toHaveBeenCalledExactlyOnceWith(7)
  })

  it('preserves the existing absent-override behavior for the selected routine', () => {
    setConfiguration({ ...configuration, routines: {} })
    expect(assertEnabled).not.toThrow()
  })

  it.each(['1', 'true', 'TRUE', 'yes', 'unexpected', ' '])(
    'refuses environment kill value %j without opening configuration',
    (value) => {
      vi.stubEnv(DECISION_KILL_ENV, value)
      expect(assertEnabled).toThrow(REFUSAL)
      expect(filesystem.openSync).not.toHaveBeenCalled()
      expect(filesystem.closeSync).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, '', '0', 'false', 'FALSE', 'FaLsE'])(
    'lets valid live configuration decide when the environment switch is %j',
    (value) => {
      vi.stubEnv(DECISION_KILL_ENV, value)
      expect(assertEnabled).not.toThrow()
    }
  )

  it('rechecks the environment switch after the configuration read', () => {
    filesystem.readSync.mockImplementation((_fd: number, buffer: Buffer) => {
      vi.stubEnv(DECISION_KILL_ENV, '1')
      return contents.copy(buffer)
    })
    expect(assertEnabled).toThrow(REFUSAL)
    expect(filesystem.closeSync).toHaveBeenCalledExactlyOnceWith(7)
  })

  it('keeps the final environment fence after closing the configuration descriptor', () => {
    filesystem.closeSync.mockImplementation(() => {
      vi.stubEnv(DECISION_KILL_ENV, '1')
    })
    expect(assertEnabled).toThrow(REFUSAL)
  })

  it.each([
    null,
    [],
    {},
    { ...configuration, version: 2 },
    { ...configuration, enabled: false },
    { ...configuration, enabled: 'true' },
    { ...configuration, killSwitch: true },
    { ...configuration, unexpected: true },
    { ...configuration, capabilities: {} },
    { ...configuration, capabilities: { 'advertising.routine': { mode: 'off' } } },
    { ...configuration, capabilities: { 'advertising.routine': { mode: 'shadow' } } },
    { ...configuration, capabilities: { 'routine.structured': { mode: 'live' } } },
    { ...configuration, routines: { [ROUTINE]: { mode: 'off' } } },
    { ...configuration, routines: { [ROUTINE]: { mode: 'shadow' } } }
  ])('refuses disabled, incomplete or malformed live configuration: %j', (value) => {
    setConfiguration(value)
    expect(assertEnabled).toThrow(REFUSAL)
    expect(filesystem.closeSync).toHaveBeenCalledExactlyOnceWith(7)
  })

  it('does not borrow another routine live override', () => {
    setConfiguration({
      ...configuration,
      routines: { [ROUTINE]: { mode: 'off' }, 'another-routine': { mode: 'live' } }
    })
    expect(assertEnabled).toThrow(REFUSAL)
    expect(() => assertDecisionLiveActionEnabled(PATH, 'another-routine')).not.toThrow()
  })

  it('reloads changes instead of retaining a previously live decision', () => {
    expect(assertEnabled).not.toThrow()
    setConfiguration({ ...configuration, killSwitch: true })
    expect(assertEnabled).toThrow(REFUSAL)
    setConfiguration(configuration)
    expect(assertEnabled).not.toThrow()
    expect(filesystem.openSync).toHaveBeenCalledTimes(3)
  })

  it.each(['lstatSync', 'openSync', 'fstatSync', 'readSync'] as const)(
    'sanitizes unavailable configuration at %s',
    (operation) => {
      filesystem[operation].mockImplementation(() => {
        throw new Error(PRIVATE_DETAIL)
      })
      expect(assertEnabled).toThrow(REFUSAL)
      expect(assertEnabled).not.toThrow(PRIVATE_DETAIL)
    }
  )

  it.each([
    { isFile: () => false },
    { isFile: () => false, isSymbolicLink: () => true },
    { size: 32 * 1024 + 1 }
  ])('refuses nonregular, symbolic or oversized configuration before reading: %j', (patch) => {
    filesystem.lstatSync.mockImplementation(() => metadata(patch))
    filesystem.fstatSync.mockImplementation(() => metadata(patch))
    expect(assertEnabled).toThrow(REFUSAL)
    expect(filesystem.readSync).not.toHaveBeenCalled()
  })

  it('opens nonblocking and refuses following a final symlink', () => {
    expect(assertEnabled).not.toThrow()
    const flags = filesystem.openSync.mock.calls[0]![1] as number
    if (constants.O_NONBLOCK !== undefined) {
      expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
    }
    if (constants.O_NOFOLLOW !== undefined) {
      expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
    }
  })

  it('accepts exactly 32 KiB of valid JSON and refuses larger data', () => {
    contents = Buffer.from(JSON.stringify(configuration).padEnd(32 * 1024, ' '))
    expect(assertEnabled).not.toThrow()
    contents = Buffer.concat([contents, Buffer.from(' ')])
    expect(assertEnabled).toThrow(REFUSAL)
  })

  it.each(['empty', 'json', 'utf8'] as const)('refuses malformed %s bytes', (kind) => {
    contents =
      kind === 'empty'
        ? Buffer.alloc(0)
        : kind === 'json'
          ? Buffer.from('{')
          : Buffer.concat([contents, Buffer.from([0xff])])
    expect(assertEnabled).toThrow(REFUSAL)
  })

  it.each([-1, 1])('refuses a bounded read count that differs from stat size by %i', (change) => {
    filesystem.readSync.mockImplementation((_fd: number, buffer: Buffer) => {
      contents.copy(buffer)
      return contents.length + change
    })
    expect(assertEnabled).toThrow(REFUSAL)
    expect(filesystem.closeSync).toHaveBeenCalledExactlyOnceWith(7)
  })

  it.each(['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs'] as const)(
    'refuses a changed %s between path and opened descriptor',
    (field) => {
      filesystem.fstatSync.mockImplementation(() => {
        const initial = metadata()
        return metadata({ [field]: initial[field] + 1 })
      })
      expect(assertEnabled).toThrow(REFUSAL)
    }
  )

  it.each(['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs'] as const)(
    'refuses a changed descriptor %s during the bounded read',
    (field) => {
      filesystem.fstatSync.mockImplementationOnce(() => metadata())
      filesystem.fstatSync.mockImplementation(() => {
        const initial = metadata()
        return metadata({ [field]: initial[field] + 1 })
      })
      expect(assertEnabled).toThrow(REFUSAL)
    }
  )

  it('refuses an atomic path replacement while the previous live descriptor remains open', () => {
    filesystem.lstatSync.mockImplementationOnce(() => metadata())
    filesystem.lstatSync.mockImplementation(() => metadata({ ino: 3 }))
    expect(assertEnabled).toThrow(REFUSAL)
    expect(filesystem.closeSync).toHaveBeenCalledExactlyOnceWith(7)
  })

  it('refuses a path removed after opening rather than admitting the old descriptor', () => {
    filesystem.lstatSync.mockImplementationOnce(() => metadata())
    filesystem.lstatSync.mockImplementation(() => {
      throw new Error(PRIVATE_DETAIL)
    })
    expect(assertEnabled).toThrow(REFUSAL)
  })

  it('sanitizes close failures rather than exposing private filesystem details', () => {
    filesystem.closeSync.mockImplementation(() => {
      throw new Error(PRIVATE_DETAIL)
    })
    expect(assertEnabled).toThrow(REFUSAL)
    expect(assertEnabled).not.toThrow(PRIVATE_DETAIL)
  })
})
