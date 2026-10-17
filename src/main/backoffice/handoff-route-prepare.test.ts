import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HANDOFF_MANIFEST_NAME, parseHandoffManifest } from '../../shared/handoff-manifest'
import { handoffBranchName } from '../../shared/handoff-route-preparation'
import { prepareHandoffFileRoutes } from './handoff-route-prepare'
import { checkIgnoredPaths } from '../git/check-ignored-paths'

/**
 * Real git again: the whole point of the preparation is that the routing rule is answered by the
 * repository itself — is this file inside it, does it ignore it — and that the commit really lands.
 */
let root: string
let origin: string
let repo: string

function run(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root }
  }).trim()
}

function pin(path: string, name: string) {
  const bytes = readFileSync(path)
  return {
    sourcePath: path,
    name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: statSync(path).size
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'omni-route-prepare-'))
  origin = join(root, 'origin.git')
  repo = join(root, 'repo')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { env: process.env })
  execFileSync('git', ['clone', origin, repo], { env: { ...process.env, HOME: root } })
  run(['config', 'user.email', 'sal@example.test'], repo)
  run(['config', 'user.name', 'Sal'], repo)
  writeFileSync(join(repo, '.gitignore'), 'secrets/\n.omni/\n')
  run(['add', '-A'], repo)
  run(['commit', '-m', 'base'], repo)
  run(['push', '-u', 'origin', 'main'], repo)
  mkdirSync(join(repo, 'out'), { recursive: true })
  mkdirSync(join(repo, 'secrets'), { recursive: true })
  writeFileSync(join(repo, 'out', 'plan.md'), 'the plan\n')
  writeFileSync(join(repo, 'secrets', 'token.env'), 'TOKEN=1\n')
  writeFileSync(join(root, 'brief.pdf'), 'outside the repo\n')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('prepareHandoffFileRoutes', () => {
  it('leaves folder workspaces untouched when working-tree inclusion is requested', async () => {
    const result = await prepareHandoffFileRoutes({
      workspacePath: root,
      branch: handoffBranchName('folder'),
      label: 'Folder',
      memo: '',
      pins: [],
      next: 'person',
      sameWorktree: false,
      includeWorkingTree: true
    })
    expect(result).toEqual({ git: null, pins: [], memoLines: [], refused: [], manifest: [] })
  })

  it('commits the repo file, leaves the rest to travel as bytes, and writes the index', async () => {
    const pins = [
      pin(join(repo, 'out', 'plan.md'), 'plan.md'),
      pin(join(repo, 'secrets', 'token.env'), 'token.env'),
      pin(join(root, 'brief.pdf'), 'brief.pdf'),
      { sourcePath: null, name: 'session-summary.md', sha256: 'a'.repeat(64), size: 10 }
    ]

    const result = await prepareHandoffFileRoutes({
      workspacePath: repo,
      branch: handoffBranchName('chn_route_1'),
      label: 'Seedance lander',
      memo: 'Take it from here.',
      pins,
      next: 'person',
      sameWorktree: false,
      includeWorkingTree: false
    })

    expect(result.refused).toEqual([])
    expect(result.git).toMatchObject({
      branch: 'handoff/chn_route_1',
      sha: expect.stringMatching(/^[a-f0-9]{40}$/)
    })
    expect(run(['show', `${result.git!.sha}:out/plan.md`], repo)).toBe('the plan')
    // An ignored file is never committed: it travels as bytes instead.
    expect(() => run(['show', `${result.git!.sha}:secrets/token.env`], repo)).toThrow()

    // The committed file drops out of the byte-carried pins; the manifest joins them.
    expect(result.pins.map((entry) => entry.name)).toEqual([
      'token.env',
      'brief.pdf',
      'session-summary.md',
      HANDOFF_MANIFEST_NAME
    ])
    expect(result.memoLines).toEqual([
      `Branch: handoff/chn_route_1 @ ${result.git!.sha.slice(0, 12)} (${result.git!.repo})`,
      'Files: 1 by git, 3 on the thread (see handoff-manifest.json)'
    ])

    const manifestPin = result.pins.at(-1)!
    const manifest = parseHandoffManifest(readFileSync(manifestPin.sourcePath!, 'utf8'))!
    expect(manifest.memo).toBe('Take it from here.')
    expect(manifest.files).toEqual([
      expect.objectContaining({ rel: 'out/plan.md', route: 'git' }),
      expect.objectContaining({ rel: 'secrets/token.env', route: 'pin' }),
      expect.objectContaining({ rel: 'brief.pdf', route: 'pin' }),
      expect.objectContaining({ rel: 'session-summary.md', route: 'pin' })
    ])
    // The manifest's own pin must be the bytes on disk, or the receiver refuses it.
    const bytes = readFileSync(manifestPin.sourcePath!)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifestPin.sha256)
    expect(manifestPin.size).toBe(bytes.byteLength)
  })

  it('moves nothing at all when the next step is an agent on the same worktree', async () => {
    const result = await prepareHandoffFileRoutes({
      workspacePath: repo,
      branch: handoffBranchName('chn_route_2'),
      label: 'same worktree',
      memo: '',
      pins: [pin(join(repo, 'out', 'plan.md'), 'plan.md')],
      next: 'agent',
      sameWorktree: true,
      includeWorkingTree: false
    })

    expect(result).toMatchObject({ git: null, pins: [], memoLines: [], refused: [] })
    // No branch was created at all: git exits non-zero because the ref does not exist.
    expect(() => run(['rev-parse', '--verify', 'refs/heads/handoff/chn_route_2'], repo)).toThrow()
  })

  it('refuses the whole send when one file is above every ceiling, naming it', async () => {
    const huge = join(root, 'render.mov')
    // A sparse file: the rule reads the size on disk, and 40 MB is past the card ceiling.
    const handle = openSync(huge, 'w')
    ftruncateSync(handle, 40 * 1024 * 1024)
    closeSync(handle)

    const result = await prepareHandoffFileRoutes({
      workspacePath: repo,
      branch: handoffBranchName('chn_route_3'),
      label: 'too big',
      memo: '',
      pins: [
        { sourcePath: huge, name: 'render.mov', sha256: 'b'.repeat(64), size: 40 * 1024 * 1024 }
      ],
      next: 'person',
      sameWorktree: false,
      includeWorkingTree: false
    })

    expect(result.git).toBeNull()
    expect(result.manifest).toEqual([])
    expect(result.refused).toEqual([
      { name: 'render.mov', reason: expect.stringContaining('the card upload ceiling is 32 MB') }
    ])
    // Nothing was committed and no index was written for a send that cannot go.
    expect(() => run(['rev-parse', '--verify', 'refs/heads/handoff/chn_route_3'], repo)).toThrow()
  })

  it('names the branch it is already on when a replay would add nothing', async () => {
    const request = {
      workspacePath: repo,
      branch: handoffBranchName('chn_route_4'),
      label: 'replay',
      memo: '',
      pins: [pin(join(repo, 'out', 'plan.md'), 'plan.md')],
      next: 'person' as const,
      sameWorktree: false,
      includeWorkingTree: false
    }
    const first = await prepareHandoffFileRoutes(request)
    const second = await prepareHandoffFileRoutes(request)

    expect(first.git?.sha).toBeTruthy()
    expect(second.git?.sha).toBe(first.git?.sha)
    expect(second.refused).toEqual([])
  })

  it('routes current bytes of tracked, now-ignored unusual paths through pins', async () => {
    const names = [
      'résumé.bin',
      '-option.txt',
      ' space.txt',
      ...(process.platform === 'win32'
        ? []
        : ['tab\tname', 'line\nname', 'quote"name', 'tail ', 'back\\slash'])
    ]
    mkdirSync(join(repo, 'ignored-odd'))
    const paths = names.map((name) => `ignored-odd/${name}`)
    for (const path of paths) {
      writeFileSync(join(repo, path), 'tracked baseline\n')
    }
    run(['add', '--', ...paths.map((path) => `:(literal)${path}`)], repo)
    run(['commit', '-m', 'tracked unusual filenames'], repo)
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'ignored-odd/\n')
    for (const path of paths) {
      writeFileSync(join(repo, path), 'selected new bytes\n')
    }
    expect(await checkIgnoredPaths(repo, paths)).toEqual([])
    expect(await checkIgnoredPaths(repo, [...paths, 'out/plan.md'], { noIndex: true })).toEqual(
      paths
    )
    const result = await prepareHandoffFileRoutes({
      workspacePath: repo,
      branch: handoffBranchName('chn_ignored_odd'),
      label: 'ignored files',
      memo: '',
      pins: paths.map((path, i) => pin(join(repo, path), `file-${i}`)),
      next: 'person',
      sameWorktree: false,
      includeWorkingTree: false
    })
    expect(result.refused).toEqual([])
    expect(result.git).toBeNull()
    expect(result.pins.slice(0, paths.length).map((entry) => entry.sourcePath)).toEqual(
      paths.map((path) => join(repo, path))
    )
    expect(() =>
      run(['rev-parse', '--verify', 'refs/heads/handoff/chn_ignored_odd'], repo)
    ).toThrow()
  })

  it('keeps every candidate off Git when its ignore status cannot be read', async () => {
    run(['config', 'core.excludesFile', repo], repo)
    try {
      const result = await prepareHandoffFileRoutes({
        workspacePath: repo,
        branch: handoffBranchName('chn_ignore_error'),
        label: 'unreadable ignore rules',
        memo: '',
        pins: [pin(join(repo, 'out', 'plan.md'), 'plan.md')],
        next: 'person',
        sameWorktree: false,
        includeWorkingTree: false
      })
      expect(result.git).toBeNull()
      expect(result.pins[0]?.name).toBe('plan.md')
      expect(() =>
        run(['rev-parse', '--verify', 'refs/heads/handoff/chn_ignore_error'], repo)
      ).toThrow()
    } finally {
      run(['config', '--unset', 'core.excludesFile'], repo)
    }
  })

  it('publishes the same local commit after the push destination becomes reachable', async () => {
    const request = {
      workspacePath: repo,
      branch: handoffBranchName('chn_push_retry'),
      label: 'retry',
      memo: '',
      pins: [pin(join(repo, 'out', 'plan.md'), 'plan.md')],
      next: 'person' as const,
      sameWorktree: false,
      includeWorkingTree: false
    }
    run(['config', 'remote.origin.pushurl', join(root, 'absent.git')], repo)
    try {
      const first = await prepareHandoffFileRoutes(request)
      expect(first.git).toBeNull()
      expect(first.manifest).toEqual([])
      expect(first.refused).toHaveLength(1)
    } finally {
      run(['config', '--unset', 'remote.origin.pushurl'], repo)
    }
    const sha = run(['rev-parse', `refs/heads/${request.branch}`], repo)
    const retry = await prepareHandoffFileRoutes(request)
    expect(retry.git?.sha).toBe(sha)
    expect(retry.refused).toEqual([])
    expect(run(['rev-parse', `refs/heads/${request.branch}`], origin)).toBe(sha)
  })

  it('refuses changed source bytes before creating a branch or manifest', async () => {
    const source = join(repo, 'out', 'changing.bin')
    writeFileSync(source, 'AAAA')
    const selected = pin(source, 'changing.bin')
    writeFileSync(source, 'BBBB')
    const result = await prepareHandoffFileRoutes({
      workspacePath: repo,
      branch: handoffBranchName('chn_changed'),
      label: 'changed',
      memo: '',
      pins: [selected],
      next: 'person',
      sameWorktree: false,
      includeWorkingTree: false
    })
    expect(result.git).toBeNull()
    expect(result.manifest).toEqual([])
    expect(result.refused[0]?.reason).toContain('changed since it was selected')
    expect(() => run(['rev-parse', '--verify', 'refs/heads/handoff/chn_changed'], repo)).toThrow()
    expect(() => run(['rev-parse', '--verify', 'refs/heads/handoff/chn_changed'], origin)).toThrow()
    expect(
      existsSync(join(repo, '.omni', 'handoffs', 'handoff-chn_changed', HANDOFF_MANIFEST_NAME))
    ).toBe(false)
  })

  it('keeps CRLF text as an exact pin while Git carries unchanged binary bytes', async () => {
    const text = join(repo, 'out', 'filtered.txt')
    const binary = join(repo, 'out', 'unchanged.bin')
    writeFileSync(text, 'line one\r\nline two\r\n')
    writeFileSync(binary, Buffer.from([0, 255, 13, 10, 254, 0]))
    const pins = [pin(text, 'filtered.txt'), pin(binary, 'unchanged.bin')]
    run(['config', 'core.autocrlf', 'true'], repo)
    run(['config', 'core.safecrlf', 'false'], repo)
    try {
      const result = await prepareHandoffFileRoutes({
        workspacePath: repo,
        branch: handoffBranchName('chn_filter'),
        label: 'filtered',
        memo: '',
        pins,
        next: 'person',
        sameWorktree: false,
        includeWorkingTree: false
      })
      expect(result.refused).toEqual([])
      expect(result.git?.sha).toBeTruthy()
      expect(result.manifest).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rel: 'out/filtered.txt',
            route: 'pin',
            sha256: pins[0].sha256
          }),
          expect.objectContaining({
            rel: 'out/unchanged.bin',
            route: 'git',
            sha256: pins[1].sha256
          })
        ])
      )
      expect(result.pins.find((entry) => entry.name === 'filtered.txt')).toEqual(pins[0])
      expect(() => run(['show', `${result.git!.sha}:out/filtered.txt`], repo)).toThrow()
    } finally {
      run(['config', '--unset', 'core.autocrlf'], repo)
      run(['config', '--unset', 'core.safecrlf'], repo)
    }
  })

  it('binds selected bytes while preserving unselected work in a session handoff', async () => {
    const source = join(repo, 'out', 'wip-selected.bin')
    writeFileSync(source, Buffer.from([1, 0, 2, 254]))
    writeFileSync(join(repo, 'unselected-wip.txt'), 'keep this work\n')
    const result = await prepareHandoffFileRoutes({
      workspacePath: repo,
      branch: handoffBranchName('chn_wip'),
      label: 'wip',
      memo: '',
      pins: [pin(source, 'wip-selected.bin')],
      next: 'person',
      sameWorktree: false,
      includeWorkingTree: true
    })
    expect(result.refused).toEqual([])
    expect(run(['show', `${result.git!.sha}:unselected-wip.txt`], repo)).toBe('keep this work')
    expect(result.manifest.find((entry) => entry.name === 'wip-selected.bin')?.route).toBe('git')
  })
})
