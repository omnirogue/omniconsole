import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { showSaveDialog, fromWebContents, getLocalWorkflowHost, show } = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  fromWebContents: vi.fn(),
  getLocalWorkflowHost: vi.fn(),
  show: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents },
  dialog: { showSaveDialog },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }
}))
vi.mock('../runtime/workflow-script/local-workflow-runtime-host', () => ({ getLocalWorkflowHost }))

import { saveLocalWorkflowResult } from './local-workflow-result-save'

const executionId = 'ded57bf7-9fa1-48cd-ab8d-914a2b908e31'
const request = { worktree: 'id:worktree-a', conversationId: 'conversation-a', executionId }
const markdown = '# Accepted final answer\n\nEvidence: café 🧭\n'
const completed = {
  executionId,
  preset: 'council',
  state: 'completed',
  fence: 2,
  sequence: 9,
  result: { markdown, sources: [], coverage: [] }
}
const mainFrame = {}
const sender = { mainFrame }
const event = { sender, senderFrame: mainFrame }
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'local-workflow-save-'))
  fromWebContents.mockReset().mockReturnValue({ id: 1 })
  getLocalWorkflowHost.mockReset().mockResolvedValue({ show })
  show.mockReset().mockResolvedValue(completed)
  showSaveDialog.mockReset()
})
afterEach(async () => rm(directory, { recursive: true, force: true }))

describe('saveLocalWorkflowResult host boundary', () => {
  it('refuses a stale or wrong conversation before opening a dialog or writing', async () => {
    show.mockRejectedValueOnce(new Error('Workflow belongs to another conversation.'))
    await expect(
      saveLocalWorkflowResult({} as never, event as never, {
        ...request,
        conversationId: 'other-conversation'
      })
    ).rejects.toThrow('another conversation')
    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
  })

  it('rejects renderer-supplied content and paths, and an incomplete result', async () => {
    await expect(
      saveLocalWorkflowResult({} as never, event as never, {
        ...request,
        markdown: 'forged',
        filePath: join(directory, 'forged.md')
      })
    ).rejects.toThrow()
    expect(show).not.toHaveBeenCalled()
    show.mockResolvedValueOnce({ ...completed, state: 'running', result: undefined })
    await expect(saveLocalWorkflowResult({} as never, event as never, request)).rejects.toThrow(
      'Only a completed workflow result'
    )
    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
  })

  it('cancels without a write, then saves exactly the accepted markdown with a receipt', async () => {
    showSaveDialog.mockResolvedValueOnce({ canceled: true })
    expect(await saveLocalWorkflowResult({} as never, event as never, request)).toEqual({
      saved: false,
      cancelled: true
    })
    expect(await readdir(directory)).toEqual([])

    const filePath = join(directory, 'chosen.md')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath })
    const receipt = await saveLocalWorkflowResult({} as never, event as never, request)
    expect(receipt).toEqual({
      saved: true,
      filePath,
      executionId,
      sha256: createHash('sha256').update(markdown).digest('hex')
    })
    expect(await readFile(filePath, 'utf8')).toBe(markdown)
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).toEqual(['chosen.md'])
    expect(show).toHaveBeenCalledWith(request)
    expect(showSaveDialog).toHaveBeenCalledWith(
      { id: 1 },
      expect.objectContaining({ defaultPath: `council-${executionId.slice(0, 8)}.md` })
    )
  })

  it('does not widen permissions when replacing a private result file', async () => {
    const filePath = join(directory, 'private.md')
    await writeFile(filePath, 'Old result')
    await chmod(filePath, 0o600)
    showSaveDialog.mockResolvedValue({ canceled: false, filePath })
    await saveLocalWorkflowResult({} as never, event as never, request)
    expect(await readFile(filePath, 'utf8')).toBe(markdown)
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).toEqual(['private.md'])
  })

  it.skipIf(process.platform === 'win32')(
    'replaces a selected symlink without writing its target',
    async () => {
      const targetPath = join(directory, 'target.txt')
      const filePath = join(directory, 'selected.md')
      await writeFile(targetPath, 'Do not change this target')
      await symlink(targetPath, filePath)
      showSaveDialog.mockResolvedValue({ canceled: false, filePath })
      await saveLocalWorkflowResult({} as never, event as never, request)
      expect(await readFile(targetPath, 'utf8')).toBe('Do not change this target')
      expect(await readFile(filePath, 'utf8')).toBe(markdown)
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    }
  )

  it('refuses changed persisted results after the dialog and never publishes a file', async () => {
    const filePath = join(directory, 'chosen.md')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath })
    show.mockResolvedValueOnce(completed).mockResolvedValueOnce({
      ...completed,
      result: { ...completed.result, markdown: 'Different answer' }
    })
    await expect(saveLocalWorkflowResult({} as never, event as never, request)).rejects.toThrow(
      'changed while the save dialog was open'
    )
    expect(await readdir(directory)).toEqual([])
  })
})
