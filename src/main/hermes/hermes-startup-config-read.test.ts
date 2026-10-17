import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readHermesConfigForInstall } from './hermes-startup-config-read'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('Hermes startup config reads', () => {
  it('releases startup when a drive access prompt never finishes opening the file', async () => {
    vi.useFakeTimers()
    vi.mocked(readFile).mockImplementation(() => new Promise(() => {}))
    const result = readHermesConfigForInstall('/Volumes/Archive/.hermes/config.yaml', 25)
    await vi.advanceTimersByTimeAsync(25)
    expect(await result).toMatchObject({
      ok: false,
      detail: expect.stringContaining('drive access')
    })
    const options = vi.mocked(readFile).mock.calls[0]?.[1] as { signal: AbortSignal }
    expect(options.signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a denied file without treating it as a new empty configuration', async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error('Permission denied'), { code: 'EPERM' })
    )
    expect(await readHermesConfigForInstall('/denied/config.yaml')).toEqual({
      ok: false,
      detail: 'Permission denied'
    })
  })

  it('parses readable configuration and initializes only missing files', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('model: existing-model\n')
    expect(await readHermesConfigForInstall('/readable/config.yaml')).toMatchObject({
      ok: true,
      config: { model: 'existing-model' }
    })
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error('Missing'), { code: 'ENOENT' })
    )
    expect(await readHermesConfigForInstall('/missing/config.yaml')).toEqual({
      ok: true,
      config: {}
    })
  })
})
