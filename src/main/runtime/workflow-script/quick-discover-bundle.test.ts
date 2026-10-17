import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitExecFileAsync } from '../../git/runner'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import { quickDiscoverBudget } from '../../../shared/workflow-quick-discover-budget'
import {
  admitQuickDiscoverScope,
  bundleQuickDiscoverScope,
  quickDiscoverIncludesPath
} from './quick-discover-bundle'

const BUDGET = quickDiscoverBudget('claude', 'claude-opus-5')
const SEAT = {
  id: 'claude',
  agent: 'claude',
  accountId: 'a',
  model: 'claude-opus-5',
  effort: 'high',
  lineage: 'anthropic',
  policyRevision: 'r1'
} as ResolvedLocalWorkflowSeat

let root = ''
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = ''
  }
})

async function tree(files: Record<string, string | Buffer>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'quick-discover-'))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, ...path.split('/').slice(0, -1)), { recursive: true })
    await writeFile(join(root, ...path.split('/')), content)
  }
  return root
}

const noGit = async () => undefined

describe('bundleQuickDiscoverScope', () => {
  it('respects .gitignore and numbers every line under a path header', async () => {
    await tree({
      '.gitignore': 'generated/\n*.log\n',
      'src/cart.ts': 'export const total = 1\nexport const tax = 2\n',
      'src/untracked.py': 'print("new")\n',
      'generated/out.ts': 'export {}\n',
      'debug.log': 'noise\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'node_modules/pkg/index.js': 'module.exports = 1\n'
    })
    await gitExecFileAsync(['init', '-q'], { cwd: root })
    await gitExecFileAsync(['add', 'src/cart.ts', '.gitignore'], { cwd: root })
    const bundle = await bundleQuickDiscoverScope({
      root,
      scopeIds: [],
      budget: BUDGET,
      promptChars: 0
    })
    expect(bundle.files.map((file) => file.path)).toEqual(['src/cart.ts', 'src/untracked.py'])
    expect(bundle.evidence).toContain(
      '\n--- src/cart.ts ---\n   1| export const total = 1\n   2| export const tax = 2\n'
    )
    expect(bundle.files[0]).toEqual({ path: 'src/cart.ts', lines: 2, bytes: 44 })
    expect(bundle.evidence).not.toMatch(/generated|debug\.log|lockfileVersion|module\.exports/)
    expect(bundle.estimatedTokens).toBe(Math.ceil(bundle.evidence.length / 3))
  })

  it('walks a folder workspace without Git, leaving out vendored, build, secret and binary files', async () => {
    await tree({
      'app/main.go': 'package main\n',
      'vendor/lib/x.go': 'package lib\n',
      'dist/app.js': 'x()\n',
      '.env': 'KEY=1\n',
      'app/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'app/latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9]),
      'app/app.min.js': 'x()\n'
    })
    const bundle = await bundleQuickDiscoverScope({
      root,
      scopeIds: [],
      budget: BUDGET,
      promptChars: 0,
      listFiles: noGit
    })
    expect(bundle.files.map((file) => file.path)).toEqual(['app/main.go'])
    expect(bundle.skipped).toEqual([{ path: 'app/latin1.txt', reason: 'not UTF-8 text' }])
  })

  it('reads only the chosen files and folders', async () => {
    await tree({ 'a/one.ts': '1\n', 'a/two.ts': '2\n', 'b/three.ts': '3\n', 'c.ts': '4\n' })
    const bundle = await bundleQuickDiscoverScope({
      root,
      scopeIds: ['a/', 'c.ts'],
      budget: BUDGET,
      promptChars: 0,
      listFiles: noGit
    })
    expect(bundle.files.map((file) => file.path)).toEqual(['a/one.ts', 'a/two.ts', 'c.ts'])
  })

  it('refuses a scope over the budget instead of cutting it, counting the prompt too', async () => {
    await tree({ 'src/big.ts': `${'const value = 1\n'.repeat(2_000)}` })
    const small = { ...BUDGET, budgetTokens: 5_000 }
    await expect(
      bundleQuickDiscoverScope({
        root,
        scopeIds: [],
        budget: small,
        promptChars: 0,
        listFiles: noGit
      })
    ).rejects.toThrow(/over its budget of 5,000 .*Run Discover instead \(--template discover\)/)
    const fits = await bundleQuickDiscoverScope({
      root,
      scopeIds: [],
      budget: { ...BUDGET, budgetTokens: 20_000 },
      promptChars: 0,
      listFiles: noGit
    })
    await expect(
      bundleQuickDiscoverScope({
        root,
        scopeIds: [],
        budget: { ...BUDGET, budgetTokens: fits.estimatedTokens },
        promptChars: 30,
        listFiles: noGit
      })
    ).rejects.toThrow('Run Discover instead')
  })

  it('refuses a scope with nothing to read', async () => {
    await tree({ 'dist/app.js': 'x()\n' })
    await expect(
      bundleQuickDiscoverScope({
        root,
        scopeIds: [],
        budget: BUDGET,
        promptChars: 0,
        listFiles: noGit
      })
    ).rejects.toThrow('found no source files')
  })
})

describe('quickDiscoverIncludesPath', () => {
  it.each([
    ['src/a.ts', true],
    ['docs/guide.md', true],
    ['node_modules/x/index.js', false],
    ['packages/web/build/out.js', false],
    ['.github/workflows/ci.yml', false],
    ['yarn.lock', false],
    ['Cargo.lock', false],
    ['config/credentials.json', false],
    ['assets/logo.png', false]
  ])('%s → %s', (path, included) => {
    expect(quickDiscoverIncludesPath(path)).toBe(included)
  })
})

describe('admitQuickDiscoverScope', () => {
  it('freezes the bundle as the run scope, only for a workspace on this computer', async () => {
    await tree({ 'src/a.ts': 'export {}\n' })
    const workspace = { id: 'w', path: root, label: 'w' }
    await expect(
      admitQuickDiscoverScope({ workspace, scopeIds: [], seat: SEAT, promptChars: 0 })
    ).rejects.toThrow('choose a local workspace')
    const scope = await admitQuickDiscoverScope({
      workspace: { ...workspace, executionHost: 'local' },
      scopeIds: ['src/'],
      seat: SEAT,
      promptChars: 0
    })
    expect(scope.coverage).toEqual(['src/a.ts'])
    expect(scope.sources).toEqual([{ ref: 'src/a.ts', description: 'src/a.ts (1 line)' }])
    expect(scope.evidence).toContain('--- src/a.ts ---\n   1| export {}')
    await expect(
      admitQuickDiscoverScope({
        workspace: { ...workspace, executionHost: 'local' },
        scopeIds: [],
        seat: undefined,
        promptChars: 0
      })
    ).rejects.toThrow('needs its "find" step')
  })
})

it('refuses admission when even one source was skipped', async () => {
  await tree({ 'ok.ts': 'export {}', 'large.ts': 'x'.repeat(256 * 1024 + 1) })
  await expect(
    admitQuickDiscoverScope({
      workspace: { id: 'x', label: 'x', path: root, executionHost: 'local' },
      scopeIds: [],
      seat: SEAT,
      promptChars: 0
    })
  ).rejects.toThrow('large.ts (larger than')
})

it('refuses a capped Git file list instead of silently truncating it', async () => {
  await tree({ 'ok.ts': 'export {}' })
  await expect(
    bundleQuickDiscoverScope({
      root,
      scopeIds: [],
      budget: BUDGET,
      promptChars: 0,
      listFiles: async () => Array.from({ length: 20_001 }, (_, i) => `${i}.ts`)
    })
  ).rejects.toThrow('file list hit its cap')
})

it('discloses listed source paths that are directories instead of silently omitting them', async () => {
  await tree({ 'directory.ts/nested.ts': 'export {}', 'ok.ts': 'export {}' })
  const bundle = await bundleQuickDiscoverScope({ root, scopeIds: [], budget: BUDGET, promptChars: 0, listFiles: async () => ['directory.ts', 'ok.ts'] })
  expect(bundle.skipped).toEqual([{ path: 'directory.ts', reason: 'not a regular file' }])
})
