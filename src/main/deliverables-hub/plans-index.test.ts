import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type * as os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: () => fixture.home
}))

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
  vi.resetModules()
})

describe('Plans deliverables index', () => {
  it('indexes nested and ignored Markdown by body while excluding escaped links', async () => {
    fixture.home = await mkdtemp(join(tmpdir(), 'deliverables-hub-'))
    homes.push(fixture.home)
    const root = join(fixture.home, 'Work', 'Ops', 'Plans')
    await mkdir(join(root, 'wave', 'nested'), { recursive: true })
    await mkdir(join(root, 'node_modules'), { recursive: true })
    const plan = join(root, 'wave', 'nested', 'W19-19-PLAN.md')
    await writeFile(plan, '# Deliverables Hub\n\nThe refund workflow is ready.\n')
    await writeFile(join(root, 'node_modules', 'hidden.md'), '# Hidden refund')
    const outside = join(fixture.home, 'outside.md')
    await writeFile(outside, '# Outside refund')
    await symlink(outside, join(root, 'escape.md'))

    const { searchPlans, resolvePlan } = await import('./plans-index')
    const found = await searchPlans('refund')
    expect(found.total).toBe(1)
    expect(found.entries[0]).toMatchObject({
      title: 'Deliverables Hub',
      taskId: 'W19-19',
      relativePath: join('wave', 'nested', 'W19-19-PLAN.md')
    })
    expect(await resolvePlan(found.entries[0]!.relativePath, found.entries[0]!.modifiedAt)).toBe(
      await realpath(plan)
    )
    await expect(resolvePlan('../outside.md', found.entries[0]!.modifiedAt)).rejects.toThrow()
    await expect(resolvePlan('escape.md', found.entries[0]!.modifiedAt)).rejects.toThrow()

    await writeFile(plan, `${await readFile(plan, 'utf8')}Changed.\n`)
    await utimes(plan, new Date(), new Date(found.entries[0]!.modifiedAt + 5000))
    await expect(
      resolvePlan(found.entries[0]!.relativePath, found.entries[0]!.modifiedAt)
    ).rejects.toThrow('changed')
  })
})
