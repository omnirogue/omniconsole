import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readExactHandoffFile } from './exact-handoff-file-read'
import { HANDOFF_FILE_MAX_BYTES } from './console-handoff-contract'
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'handoff-exact-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
describe('exact handoff snapshot', () => {
  it.each(['docx', 'pptx', 'pdf', 'txt'])(
    'preserves invalid UTF-8 and zero bytes in %s',
    async (extension) => {
      const bytes = Buffer.from([0x50, 0x4b, 0, 255, 254, 128, 65])
      const path = join(directory, `file.${extension}`)
      await writeFile(path, bytes)
      const file = await readExactHandoffFile(path)
      expect(Buffer.from(file.contentBase64, 'base64')).toEqual(bytes)
      expect(file.size).toBe(bytes.length)
    }
  )
  it('refuses a directory and oversized original instead of returning a preview', async () => {
    await mkdir(join(directory, 'folder'))
    await expect(readExactHandoffFile(join(directory, 'folder'))).rejects.toThrow()
    await writeFile(join(directory, 'large.docx'), Buffer.alloc(HANDOFF_FILE_MAX_BYTES + 1))
    await expect(readExactHandoffFile(join(directory, 'large.docx'))).rejects.toThrow()
  })
})
