import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import * as processSpec from './worktree-metadata-process'

export async function buildWorktreeMetadataTestEntry(): Promise<{
  entry: string
  cleanup: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'omni-worktree-metadata-entry-'))
  const entry = join(root, 'worktree-metadata-process-entry.cjs')
  await build({
    entryPoints: [resolve('src/main/git/worktree-metadata-process-entry.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
  return { entry, cleanup: () => rm(root, { recursive: true, force: true }) }
}

export function registerWorktreeMetadataTestEntry(): void {
  let fixture: Awaited<ReturnType<typeof buildWorktreeMetadataTestEntry>>
  const original = processSpec.worktreeMetadataProcessSpec
  let restore: (() => void) | undefined
  beforeAll(async () => {
    fixture = await buildWorktreeMetadataTestEntry()
  })
  beforeEach(() => {
    const spy = vi
      .spyOn(processSpec, 'worktreeMetadataProcessSpec')
      .mockImplementation(() => original(fixture.entry))
    restore = () => spy.mockRestore()
  })
  afterEach(() => restore?.())
  afterAll(async () => {
    await fixture?.cleanup()
  })
}
