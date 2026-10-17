import { constants } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDecisionConfigurationReader,
  disabledDecisionConfiguration
} from './decision-configuration'

const { open } = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('node:fs/promises', () => ({ open }))
beforeEach(() => vi.clearAllMocks())

describe('decision configuration file admission', () => {
  it.each(['fifo', 'directory', 'device'])(
    'opens nonblocking and refuses a %s before reading',
    async () => {
      const read = vi.fn()
      const close = vi.fn().mockResolvedValue(undefined)
      open.mockResolvedValue({ stat: async () => ({ size: 0, isFile: () => false }), read, close })
      const configuration = createDecisionConfigurationReader('profile/structured-decisions.json', {
        environment: () => ({})
      })

      await expect(configuration()).resolves.toEqual(disabledDecisionConfiguration())
      expect(open).toHaveBeenCalledWith(
        'profile/structured-decisions.json',
        constants.O_RDONLY | constants.O_NONBLOCK
      )
      expect(read).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledTimes(1)
    }
  )

  it('closes a regular file whose declared size exceeds the configured bound', async () => {
    const read = vi.fn()
    const close = vi.fn().mockResolvedValue(undefined)
    open.mockResolvedValue({
      stat: async () => ({ size: 32 * 1024 + 1, isFile: () => true }),
      read,
      close
    })
    const configuration = createDecisionConfigurationReader('large.json', {
      environment: () => ({})
    })

    await expect(configuration()).resolves.toEqual(disabledDecisionConfiguration())
    expect(read).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
