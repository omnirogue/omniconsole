import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionFollowUpRule } from '../../shared/session-follow-up-rule'
import { normalizeSessionFollowUpRule } from '../../shared/session-follow-up-rule'
import { captureSessionHandoff } from './session-handoff-capture'

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'handoff-folder-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const folder = join(root, 'chosen')
  await mkdir(workspace)
  await mkdir(folder)
  const path = join(workspace, 'result.bin')
  const bytes = Buffer.from([0, 1, 255, 128, 42])
  await writeFile(path, bytes)
  const rule: SessionFollowUpRule = {
    revision: 1,
    taskId: null,
    taskTitle: 'Session',
    sessionLabel: 'Session',
    recipients: [
      {
        employeeId: 'emp_recipient',
        name: 'Teammate',
        operationId: 'handoff_folder_test',
        delivery: 'pending'
      }
    ],
    deliverables: { kind: 'files', paths: [path] },
    destinationDirectory: folder,
    includeSummary: true,
    note: 'Continue the work',
    savedAt: 1
  }
  return { workspace, folder, path, bytes, rule }
}
it('saves identical binary artifacts and context in the selected folder, retaining names and hashes through persistence', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-19T12:00:00Z'))
  const f = await fixture()
  const captured = normalizeSessionFollowUpRule(
    await captureSessionHandoff(f.rule, f.workspace, 'Current context')
  )!
  expect(captured.destinationDirectory).toBe(f.folder)
  expect(captured.taskId).toBeNull()
  expect(await readFile(join(f.folder, 'result.bin'))).toEqual(f.bytes)
  expect(captured.files?.[0]).toMatchObject({
    sourcePath: join(f.folder, 'result.bin'),
    sha256: createHash('sha256').update(f.bytes).digest('hex')
  })
  expect(await readFile(captured.files![1]!.sourcePath!, 'utf8')).toBe('Current context')
  // Reopening the persisted capture keeps its names even when the clock has advanced.
  vi.setSystemTime(new Date('2026-09-19T12:01:00Z'))
  await expect(
    captureSessionHandoff(captured, f.workspace, 'Current context')
  ).resolves.toMatchObject({ files: captured.files })
})
it('uses the workspace default without overwriting its existing artifact', async () => {
  const f = await fixture()
  const captured = await captureSessionHandoff(
    { ...f.rule, destinationDirectory: f.workspace },
    f.workspace,
    'snapshot'
  )
  expect(captured.files?.[0]?.sourcePath).toBe(f.path)
  expect(await readFile(f.path)).toEqual(f.bytes)
})
it('refuses a different existing file and a symbolic-link destination', async () => {
  const f = await fixture()
  const destination = join(f.folder, 'result.bin')
  await writeFile(destination, 'keep mine')
  await expect(captureSessionHandoff(f.rule, f.workspace, 'context')).rejects.toThrow(
    'destination changed'
  )
  expect(await readFile(destination, 'utf8')).toBe('keep mine')
  await rm(destination)
  await symlink(f.path, destination)
  await expect(captureSessionHandoff(f.rule, f.workspace, 'context')).rejects.toThrow(
    'regular file'
  )
  expect(await readFile(f.path)).toEqual(f.bytes)
})
it('does not manufacture a final report or capture completion when a declared file is missing', async () => {
  const f = await fixture()
  await rm(f.path)
  await expect(captureSessionHandoff(f.rule, f.workspace, 'context')).rejects.toThrow(
    'deliverables missing'
  )
})
it('refuses an existing symbolic-link source instead of waiting forever for it as a missing file', async () => {
  const f = await fixture()
  const pointer = join(f.workspace, 'pointer.bin')
  await symlink(f.path, pointer)
  await expect(
    captureSessionHandoff(
      { ...f.rule, deliverables: { kind: 'files', paths: [pointer] } },
      f.workspace,
      'context'
    )
  ).rejects.toThrow('symbolic link')
})
