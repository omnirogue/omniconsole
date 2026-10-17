import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GraphCheckLanes } from './graph-check-lane'
import { sweepGraphCheckLanes } from './graph-check-lane-sweep'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** An attempts folder with runs whose copies a crash left behind, beside their records. */
async function attempts(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'graph-sweep-'))
  roots.push(root)
  for (const run of ['crashed', 'live', 'no-lanes']) {
    await mkdir(join(root, run), { recursive: true })
    await writeFile(join(root, run, 'checks.json'), '{}')
  }
  for (const run of ['crashed', 'live']) {
    await mkdir(join(root, run, 'lanes', '0', 'src'), { recursive: true })
    await writeFile(join(root, run, 'lanes', '0', 'src', 'value.mjs'), 'export const value = 1\n')
  }
  // Not a run's folder: never touched, even with a lanes folder inside.
  await mkdir(join(root, 'not a run', 'lanes'), { recursive: true })
  return root
}

describe('the app-start sweep of private copies', () => {
  it('removes only the copies of runs that are not live, and nothing else of theirs', async () => {
    const root = await attempts()
    const live = new GraphCheckLanes({
      folder: join(root, 'live', 'lanes'),
      root: async () => root,
      sourceBase: 'a'.repeat(40)
    })
    expect(await sweepGraphCheckLanes(root)).toEqual(['crashed'])
    expect(existsSync(join(root, 'crashed', 'lanes'))).toBe(false)
    expect(existsSync(join(root, 'crashed', 'checks.json'))).toBe(true)
    expect(existsSync(join(root, 'live', 'lanes', '0', 'src', 'value.mjs'))).toBe(true)
    expect(existsSync(join(root, 'no-lanes', 'checks.json'))).toBe(true)
    expect(existsSync(join(root, 'not a run', 'lanes'))).toBe(true)
    // Once the live run settles, its copies are its own to remove, and a later sweep finds none.
    await live.dispose()
    expect(existsSync(join(root, 'live', 'lanes'))).toBe(false)
    expect(await sweepGraphCheckLanes(root)).toEqual([])
  })

  it('does nothing, and never throws, without an attempts folder', async () => {
    const root = await attempts()
    expect(await sweepGraphCheckLanes(join(root, 'missing'))).toEqual([])
  })
})
