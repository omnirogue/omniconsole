import { lookup } from 'node:dns/promises'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { WorktreeMetadataService } from './worktree-metadata-service'
import { worktreeMetadataProcessSpec } from './worktree-metadata-process'
import { buildWorktreeMetadataTestEntry } from './worktree-metadata-test-fixture'

let entry: Awaited<ReturnType<typeof buildWorktreeMetadataTestEntry>>
let root: string
let service: WorktreeMetadataService
let started: Promise<void>
let pidPath: string
let terminations: number

beforeAll(async () => {
  entry = await buildWorktreeMetadataTestEntry()
})
afterAll(async () => {
  await entry.cleanup()
})
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omni-worktree-metadata-isolation-'))
  pidPath = join(root, 'owned-pids.txt')
  const preload = join(root, 'record-owned-pid.cjs')
  await writeFile(
    preload,
    `require('node:fs').appendFileSync(${JSON.stringify(pidPath)}, process.pid + '\\n')`
  )
  let signalStarted: () => void
  started = new Promise((resolve) => {
    signalStarted = resolve
  })
  terminations = 0
  service = new WorktreeMetadataService(
    (spec) =>
      runProcess({
        ...spec,
        onStdout: (chunk) => {
          spec.onStdout?.(chunk)
          signalStarted()
        },
        onChildTerminated: () => {
          terminations++
          spec.onChildTerminated?.()
        }
      }),
    () => {
      const spec = worktreeMetadataProcessSpec(entry.entry)
      return { ...spec, args: ['--require', preload, ...spec.args!] }
    }
  )
})
afterEach(async () => {
  await service.stop()
  await rm(root, { recursive: true, force: true })
})

async function sparseFixture(name: string, enabled: boolean): Promise<string> {
  const path = join(root, name)
  await mkdir(join(path, '.git', 'info'), { recursive: true })
  await writeFile(join(path, '.git', 'info', 'sparse-checkout'), '/keep/\n')
  await writeFile(join(path, '.git', 'config'), `[core]\nsparseCheckout = ${enabled}\n`)
  return path
}
async function blockedFixture(name: string): Promise<string> {
  const path = join(root, name)
  await mkdir(path)
  const result = await runProcess({ program: 'mkfifo', args: [join(path, '.git')] })
  expect(result.code).toBe(0)
  return path
}
async function assertChildrenExited(expected: number): Promise<void> {
  await service.stop()
  const pids = (await readFile(pidPath, 'utf8')).trim().split('\n').map(Number)
  expect(pids).toHaveLength(expected)
  expect(terminations).toBe(expected)
  for (const pid of pids) {
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  }
}

// A real FIFO exercises the OS worker-pool failure that a never-resolving JS mock cannot.
describe.skipIf(process.platform === 'win32')('worktree filesystem process isolation', () => {
  it('admits actual directory and Git marker reads, including a linked gitdir', async () => {
    const empty = join(root, 'empty')
    const checkout = await sparseFixture('checkout', false)
    const linked = join(root, 'linked')
    const alias = join(root, 'alias')
    await mkdir(empty)
    await mkdir(linked)
    await writeFile(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(linked, '.git'), 'gitdir: ../checkout/.git\n')
    await symlink(linked, alias)
    const paths = [empty, checkout, linked, alias]
    const results = await service.probe('readable', paths)
    for (const path of paths) {
      expect(results.get(path)).toMatchObject({ operation: 'readable', value: true })
    }
    await assertChildrenExited(1)
  })

  it('refuses stat-readable FIFOs and an unavailable linked gitdir without blocking healthy reads', async () => {
    const blocked = await blockedFixture('fifo-marker')
    expect((await stat(join(blocked, '.git'))).isFIFO()).toBe(true)
    const healthy = join(root, 'healthy')
    const linked = join(root, 'linked')
    const gitdir = join(root, 'gitdir')
    await Promise.all([mkdir(healthy), mkdir(linked), mkdir(gitdir)])
    await writeFile(join(linked, '.git'), 'gitdir: ../gitdir\n')
    expect((await runProcess({ program: 'mkfifo', args: [join(gitdir, 'HEAD')] })).code).toBe(0)
    const since = Date.now()
    const results = await service.probe('readable', [blocked, linked, healthy])
    expect(results.get(blocked)).toBeUndefined()
    expect(results.get(linked)).toBeUndefined()
    expect(results.get(healthy)).toMatchObject({ operation: 'readable', value: true })
    expect((await Promise.all([stat(root), lookup('localhost')]))[0].isDirectory()).toBe(true)
    expect(Date.now() - since).toBeLessThan(4_500)
    await assertChildrenExited(1)
  })

  it.skipIf(process.getuid?.() === 0)(
    'keeps denied directory and marker reads unknown',
    async () => {
      const deniedRoot = join(root, 'denied-root')
      const deniedMarker = join(root, 'denied-marker')
      await Promise.all([mkdir(deniedRoot), mkdir(deniedMarker)])
      await writeFile(join(deniedMarker, '.git'), 'gitdir: ../unused\n')
      await chmod(deniedRoot, 0)
      await chmod(join(deniedMarker, '.git'), 0)
      try {
        const results = await service.probe('readable', [deniedRoot, deniedMarker])
        expect([...results.values()]).toEqual([undefined, undefined])
        await assertChildrenExited(1)
      } finally {
        await chmod(deniedRoot, 0o700)
        await chmod(join(deniedMarker, '.git'), 0o600)
      }
    }
  )

  it('refuses incomplete repositories, symlink markers and oversized gitdir records', async () => {
    const incomplete = await sparseFixture('incomplete', false)
    const symbolic = join(root, 'symbolic')
    const oversized = join(root, 'oversized')
    await Promise.all([mkdir(symbolic), mkdir(oversized)])
    await symlink(join(incomplete, '.git'), join(symbolic, '.git'))
    await writeFile(join(oversized, '.git'), `gitdir: ${'x'.repeat(17_000)}`)
    const results = await service.probe('readable', [incomplete, symbolic, oversized])
    expect([...results.values()]).toEqual([undefined, undefined, undefined])
    await assertChildrenExited(1)
  })

  it('returns healthy hints before timeout, preserves blocked paths and keeps parent fs/DNS responsive', async () => {
    const blocked = await blockedFixture('blocked')
    const enabled = await sparseFixture('enabled', true)
    const disabled = await sparseFixture('disabled', false)
    const startedAt = Date.now()
    const pending = service.probe('sparse', [blocked, enabled, disabled])
    await started
    const healthy = service.probe('sparse', [enabled])
    const parentResponsive = await Promise.all([stat(root), lookup('localhost')])
    expect(parentResponsive[0].isDirectory()).toBe(true)
    expect((await healthy).get(enabled)?.value).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(1_500)
    const results = await pending
    expect(results.get(blocked)).toBeUndefined()
    expect(results.get(enabled)?.value).toBe(true)
    expect(results.get(disabled)?.value).toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(4_500)
    await assertChildrenExited(1)
  })

  it('advances past four stalled paths on the next poll instead of repeatedly starving a healthy sibling', async () => {
    const blocked = await Promise.all(
      Array.from({ length: 4 }, (_, index) => blockedFixture(`blocked-${index}`))
    )
    const enabled = await sparseFixture('enabled', true)
    const paths = [...blocked, enabled]
    const first = await service.probe('sparse', paths)
    expect([...first.values()]).toEqual(paths.map(() => undefined))
    const second = await service.probe('sparse', paths)
    expect(second.get(enabled)?.value).toBe(true)
    expect(blocked.every((path) => second.get(path) === undefined)).toBe(true)
    await assertChildrenExited(2)
  })

  it('reaps the exact child on caller abort', async () => {
    const blocked = await blockedFixture('blocked')
    const controller = new AbortController()
    const pending = service.probe('sparse', [blocked], controller.signal)
    await started
    controller.abort()
    expect((await pending).get(blocked)).toBeUndefined()
    await assertChildrenExited(1)
  })
})
