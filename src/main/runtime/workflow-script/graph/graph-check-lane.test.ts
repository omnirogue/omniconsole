import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitExecFileAsync } from '../../../git/command-runner/git-exec-file'
import {
  NODE,
  VALUE_TWO,
  folderFingerprint,
  laneLanes,
  lanePatchCheck,
  laneRepository,
  withDiff,
  type LaneRepository
} from './graph-check-lane.test-fixtures'

const made: LaneRepository[] = []
async function repository(): Promise<LaneRepository> {
  const repo = await laneRepository()
  made.push(repo)
  return repo
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })))
})

describe('private copies of the code (lanes)', () => {
  it('clones at the frozen commit, applies a change, runs the test there, and resets between uses', async () => {
    const repo = await repository()
    const lanes = laneLanes(repo)
    const changed = await lanePatchCheck(lanes, { candidate: withDiff(VALUE_TWO) })
    expect(changed).toMatchObject({ passed: true, score: 2 })
    const copy = join(repo.parent, 'run', 'lanes', '0')
    expect(await readFile(join(copy, 'stray.txt'), 'utf8')).toBe('left by the test')
    // "No change" reuses the copy: reset to the commit, untracked files gone, ignored ones kept.
    const unchanged = await lanePatchCheck(lanes, { candidate: 'No change', unchanged: true })
    expect(unchanged).toMatchObject({ passed: false, score: 1 })
    expect(existsSync(join(repo.parent, 'run', 'lanes', '1'))).toBe(false)
    expect(await readFile(join(copy, 'src', 'value.mjs'), 'utf8')).toBe('export const value = 1\n')
    expect(await readFile(join(copy, 'deps', 'cache.txt'), 'utf8')).toBe('kept between versions')
    const head = await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: copy })
    expect(head.stdout.trim()).toBe(repo.sourceBase)
    await lanes.dispose()
  })

  it("never touches the person's repository: no worktree entry, every byte the same", async () => {
    const repo = await repository()
    // Uncommitted work in the person's folder stays exactly as it was, and is never tested.
    await writeFile(join(repo.root, 'notes.txt'), 'mine')
    const before = await folderFingerprint(repo.root)
    const lanes = laneLanes(repo)
    await lanePatchCheck(lanes, { candidate: withDiff(VALUE_TWO) })
    await lanePatchCheck(lanes, { candidate: withDiff(VALUE_TWO) })
    await lanes.dispose()
    expect(await folderFingerprint(repo.root)).toBe(before)
    expect(existsSync(join(repo.root, '.git', 'worktrees'))).toBe(false)
    const list = await gitExecFileAsync(['worktree', 'list', '--porcelain'], { cwd: repo.root })
    expect(list.stdout.match(/^worktree /gm)).toHaveLength(1)
    expect(await readFile(join(repo.root, 'src', 'value.mjs'), 'utf8')).toBe(
      'export const value = 1\n'
    )
  })

  it('gets each copy ready once, and runs versions at the same time in copies of their own', async () => {
    const repo = await repository()
    const lanes = laneLanes(repo)
    const prepare = `${NODE} prepare.mjs`
    const one = await lanePatchCheck(lanes, { candidate: withDiff(VALUE_TWO), prepare })
    const two = await lanePatchCheck(lanes, { candidate: withDiff(VALUE_TWO), prepare })
    expect([one.passed, two.passed]).toEqual([true, true])
    const log = (lane: number) =>
      readFile(join(repo.parent, 'run', 'lanes', String(lane), 'deps', 'prepared.log'), 'utf8')
    expect(await log(0)).toBe('x')
    await Promise.all([
      lanePatchCheck(lanes, { candidate: withDiff(VALUE_TWO), prepare }),
      lanePatchCheck(lanes, { candidate: withDiff(VALUE_TWO), prepare })
    ])
    expect([await log(0), await log(1)]).toEqual(['x', 'x'])
    await lanes.dispose()
  })

  it('reports a failing prepare as unknown with its reason, never a pass, and does not repeat it', async () => {
    const repo = await repository()
    const count = join(repo.parent, 'tries.log')
    const prepare = `${NODE} prepare.mjs "${count}" fail`
    const lanes = laneLanes(repo)
    const first = await lanePatchCheck(lanes, { candidate: withDiff(VALUE_TWO), prepare })
    expect(first).toMatchObject({ passed: false, unavailable: true })
    expect(first.detail).toContain('no private copy of your code could be made')
    expect(first.detail).toContain('exited with code 3')
    const second = await lanePatchCheck(lanes, { candidate: withDiff(VALUE_TWO), prepare })
    expect(second).toMatchObject({ passed: false, unavailable: true })
    expect(await readFile(count, 'utf8')).toBe('x')
    await lanes.dispose()
    expect(existsSync(join(repo.parent, 'run', 'lanes'))).toBe(false)
  })

  it('reports a copy that cannot be made as unknown, never a pass', async () => {
    const repo = await repository()
    const lanes = laneLanes(repo, join(repo.parent, 'missing'))
    const result = await lanePatchCheck(lanes, { candidate: withDiff(VALUE_TWO) })
    expect(result).toMatchObject({ passed: false, unavailable: true })
    expect(result.score).toBeUndefined()
  })

  it('removes every copy when disposed, and sweeps what an interrupted attempt left', async () => {
    const repo = await repository()
    const folder = join(repo.parent, 'run', 'lanes')
    await mkdir(join(folder, '0', 'src'), { recursive: true })
    await writeFile(join(folder, '0', 'src', 'value.mjs'), 'export const value = 2\n')
    await writeFile(join(folder, 'left-behind.txt'), 'from a crash')
    const lanes = laneLanes(repo)
    // The leftover copy would pass; a swept, fresh copy of the commit does not.
    const result = await lanePatchCheck(lanes, { candidate: 'No change', unchanged: true })
    expect(result.passed).toBe(false)
    expect(existsSync(join(folder, 'left-behind.txt'))).toBe(false)
    await lanes.dispose()
    expect(existsSync(folder)).toBe(false)
    await expect(lanes.acquire()).rejects.toThrow('This run has finished.')
  })
})
