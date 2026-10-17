import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GraphCheckLanes } from './graph-check-lane'
import {
  VALUE_TWO,
  folderFingerprint,
  laneLanes,
  lanePatchCheck,
  laneRepository,
  withDiff,
  type LaneRepository
} from './graph-check-lane.test-fixtures'

const create = (path: string, mode = '100644', line = 'hi') =>
  [
    `diff --git a/${path} b/${path}`,
    `new file mode ${mode}`,
    'index 0000000..1234567',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    `+${line}`,
    ''
  ].join('\n')

const edit = (path: string, from: string, to: string) =>
  [`--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', `-${from}`, `+${to}`, ''].join('\n')

let repo: LaneRepository
let lanes: GraphCheckLanes
let before: string

beforeAll(async () => {
  repo = await laneRepository()
  before = await folderFingerprint(repo.root)
  lanes = laneLanes(repo)
})

afterAll(async () => {
  await lanes.dispose()
  // Not one refused, failed or tested version touched the person's own files.
  expect(await folderFingerprint(repo.root)).toBe(before)
  await rm(repo.parent, { recursive: true, force: true })
})

async function refused(diff: string, protect?: string[]) {
  const result = await lanePatchCheck(lanes, {
    candidate: withDiff(diff),
    ...(protect ? { protect } : {})
  })
  // The version's own fault: a failed check with its reason, never "could not run".
  expect(result.passed).toBe(false)
  expect(result.unavailable).toBeUndefined()
  return result.detail
}

describe('a change to the code is refused before it runs', () => {
  it('when it touches a file the person protected', async () => {
    const detail = await refused(
      edit('tests/spec.mjs', 'export const spec = 1', 'export const spec = 2'),
      ['tests/**']
    )
    expect(detail).toContain('tests/spec.mjs is protected (tests/**)')
  })

  it('when it touches anything inside .git, in any spelling', async () => {
    expect(await refused(edit('.git/config', '[core]', '[core] x'))).toContain('inside .git')
    expect(await refused(create('.GIT/hooks/post-checkout'))).toContain('inside .git')
  })

  it('when it writes a file Git ignores, or changes what Git ignores', async () => {
    expect(await refused(create('deps/evil.js'))).toContain('deps/evil.js is a file Git ignores')
    expect(await refused(edit('.gitignore', 'deps/', 'nothing/'))).toContain(
      'changes what Git ignores'
    )
  })

  it('when it makes, edits or writes through a symbolic link', async () => {
    expect(await refused(create('l2', '120000', '/etc/passwd'))).toContain('symbolic link')
    if (repo.links) {
      expect(await refused(edit('link', 'src', '/etc'))).toContain('link is a symbolic link')
      expect(await refused(create('link/new.mjs'))).toContain('link is a symbolic link')
    }
  })

  it('when it changes a submodule', async () => {
    const diff = create(
      'sub',
      '160000',
      'Subproject commit 1234567890123456789012345678901234567890'
    )
    expect(await refused(diff)).toContain('submodule')
  })

  it('when it has binary content', async () => {
    const diff = [
      'diff --git a/img.bin b/img.bin',
      'new file mode 100644',
      'index 0000000..1111111',
      'Binary files /dev/null and b/img.bin differ',
      ''
    ].join('\n')
    expect(await refused(diff)).toContain('binary content (img.bin)')
  })

  it('when a path leaves the repository', async () => {
    expect(await refused(create('../escape.txt'))).toContain('outside the repository')
    expect(existsSync(join(repo.parent, 'escape.txt'))).toBe(false)
  })

  it('when Git cannot read it, or it has no diff at all', async () => {
    expect(await refused('this is not a diff\n')).toContain('Git could not read the diff')
    const none = await lanePatchCheck(lanes, { candidate: 'I would change value to 2.' })
    expect(none).toMatchObject({ passed: false })
    expect(none.unavailable).toBeUndefined()
    expect(none.detail).toContain('no ```diff block')
  })
})

describe('a change that does not apply', () => {
  it("fails as the version's own fault, never as a check that could not run", async () => {
    const detail = await refused(edit('src/value.mjs', 'export const value = 7', 'x'))
    expect(detail).toContain('the diff does not apply to your code as it is')
  })
})

describe('a change that is tested', () => {
  it('flags an added call that ends the process early, without refusing it', async () => {
    // Two files in a plain diff (no `diff --git` lines), with a blank line between them.
    const diff = [
      VALUE_TWO,
      '--- a/test.mjs',
      '+++ b/test.mjs',
      '@@ -1,3 +1,4 @@',
      " import { mkdirSync, writeFileSync } from 'node:fs'",
      " import { value } from './src/value.mjs'",
      '+process.exit(0)',
      " writeFileSync('stray.txt', 'left by the test')",
      ''
    ].join('\n')
    const result = await lanePatchCheck(lanes, { candidate: withDiff(diff) })
    expect(result).toMatchObject({ passed: true, exits: ['process.exit'] })
    expect(result.detail).toMatch(/^Flagged: this change adds process\.exit/)
  })

  it('applies a diff with miscounted hunks, and tests it in the copy only', async () => {
    const sloppy = VALUE_TWO.replace('@@ -1 +1 @@', '@@ -1,9 +1,9 @@')
    const result = await lanePatchCheck(lanes, { candidate: withDiff(sloppy) })
    expect(result).toMatchObject({ passed: true, score: 2 })
    expect(await readFile(join(repo.root, 'src', 'value.mjs'), 'utf8')).toBe(
      'export const value = 1\n'
    )
  })
})
