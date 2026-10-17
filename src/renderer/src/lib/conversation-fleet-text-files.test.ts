import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { HANDOFF_FILE_MAX_BYTES } from '../../../shared/console-handoff-contract'
import { conversationFleetTextFiles } from './conversation-fleet-text-files'

vi.mock('./console-workflow-client', () => ({ workflowData: vi.fn() }))

it('splits a long Unicode transcript into bounded readable pieces that reproduce every original byte', async () => {
  const text = `${'a'.repeat(HANDOFF_FILE_MAX_BYTES - 1)}😀 Full ending`
  const result = await conversationFleetTextFiles(text, 'conversation', 'md')
  expect(result.files).toHaveLength(2)
  const buffers = result.files.map((file) => Buffer.from(file.contentBase64, 'base64'))
  expect(buffers.every((part) => part.length <= HANDOFF_FILE_MAX_BYTES)).toBe(true)
  expect(buffers.every((part) => !part.toString('utf8').includes('�'))).toBe(true)
  expect(Buffer.compare(Buffer.concat(buffers), Buffer.from(text))).toBe(0)
  expect(result.digest).toBe(createHash('sha256').update(text).digest('hex'))
  expect(result.files[0].name).toContain('part-01-of-2.md')
  expect(result.files[1].name).toContain('part-02-of-2.md')
})

it('refuses an oversized complete source rather than silently clipping it', async () => {
  await expect(
    conversationFleetTextFiles('a'.repeat(32 * 1024 * 1024 + 1), 'source', 'txt')
  ).rejects.toThrow('32 MB input limit')
})
