import { expect, it, vi } from 'vitest'
import { captureFollowUpFiles } from './session-follow-up-capture'
import { readFollowUpFileSnapshot } from './session-follow-up-file-snapshot'

const MiB = 1024 * 1024
const snapshot = (size: number) => ({
  name: 'video.mov',
  size,
  sha256: 'a'.repeat(64),
  contentBase64: 'YQ=='
})
const host = (size: number) => ({
  exists: vi.fn(),
  size: vi.fn().mockResolvedValue(size),
  readExact: vi.fn().mockResolvedValue(snapshot(size))
})

it.each([10 * MiB + 1, 25 * MiB])(
  'captures %i bytes for a card-less follow-on upload once',
  async (size) => {
    const io = host(size)
    const result = await captureFollowUpFiles(['/w/video.mov'], null, io, null, undefined, true)
    const reread = vi.fn()
    expect(await readFollowUpFileSnapshot(result.pins[0]!, reread)).toEqual(snapshot(size))
    expect(reread).not.toHaveBeenCalled()
    expect(io.readExact).toHaveBeenCalledTimes(1)
  }
)

it.each([10 * MiB + 1, 32 * MiB])(
  'refuses %i card-bound bytes before reading without a board delivery transport',
  async (size) => {
    const io = host(size)
    await expect(captureFollowUpFiles(['/w/video.mov'], null, io)).rejects.toMatchObject({
      code: 'file-too-large',
      subject: 'video.mov',
      detail: expect.stringContaining(`${size} bytes exceeds the ${10 * MiB} byte limit`)
    })
    expect(io.readExact).not.toHaveBeenCalled()
  }
)

it.each([25 * MiB + 1, 32 * MiB + 1])(
  'refuses %i bytes before reading ANY selected file',
  async (size) => {
    const io = host(size)
    io.size.mockResolvedValueOnce(1)
    await expect(
      captureFollowUpFiles(['/w/small.txt', '/w/video.mov'], null, io, null, undefined, true)
    ).rejects.toMatchObject({
      code: 'file-too-large',
      subject: 'video.mov',
      detail: expect.stringContaining('Split the file')
    })
    expect(io.readExact).not.toHaveBeenCalled()
  }
)

it('keeps the ordinary path at exactly 10 MiB', async () => {
  const io = host(10 * MiB)
  const result = await captureFollowUpFiles(['/w/video.mov'], null, io)
  expect(result.pins).toEqual([
    { sourcePath: '/w/video.mov', name: 'video.mov', size: 10 * MiB, sha256: 'a'.repeat(64) }
  ])
  expect(result.bytes.get('video.mov')).toEqual(snapshot(10 * MiB))
})
