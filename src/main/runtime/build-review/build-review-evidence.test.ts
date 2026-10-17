import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  reviewFindingBlocks,
  type ReviewEvidence,
  type ReviewFinding
} from '../../../shared/review-findings'
import {
  checkReviewFinding,
  checkReviewFindings,
  type ReviewEvidenceHost
} from './build-review-evidence'

// Evidence is never executed: any process start from the checks would show up here.
const spawned = vi.hoisted(() => ({ runProcess: vi.fn(), spawnProcess: vi.fn(), spawn: vi.fn() }))
vi.mock('../../../shared/child-process/run-process', async (original) => ({
  ...(await original<object>()),
  runProcess: spawned.runProcess,
  spawnProcess: spawned.spawnProcess
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  spawn: spawned.spawn,
  execFile: spawned.spawn,
  exec: spawned.spawn,
  fork: spawned.spawn
}))
afterEach(() => {
  expect(spawned.runProcess).not.toHaveBeenCalled()
  expect(spawned.spawnProcess).not.toHaveBeenCalled()
  expect(spawned.spawn).not.toHaveBeenCalled()
})

let workspace = ''
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'review-evidence-'))
  await writeFile(join(workspace, 'plan.md'), 'Step 1: deploy on Friday night.\n')
  await mkdir(join(workspace, 'docs'))
  await writeFile(join(workspace, 'package.json'), '{"name":"candidate"}\n')
  await writeFile(
    join(workspace, 'add.test.js'),
    "require('node:test')('adds', () => require('node:assert').strictEqual(1 - 2, 3))\n"
  )
})

const host = (files = ['plan.md']): ReviewEvidenceHost => ({ workspacePath: workspace, files })
const blocker = (evidence: ReviewFinding['evidence']): ReviewFinding => ({
  id: 'F1',
  severity: 'blocker',
  claim: 'broken',
  ...(evidence ? { evidence } : {})
})
const statusOf = async (evidence: ReviewEvidence, checks: ReviewEvidenceHost = host()) =>
  (await checkReviewFinding(blocker(evidence), checks)).status
const command = (program: string, ...args: string[]) => ({
  kind: 'command' as const,
  program,
  args,
  expect: 'fail' as const
})

describe('checkReviewFinding: reviewer commands', () => {
  it('never confirms or clears a blocker with any command a reviewer wrote, and never runs it', async () => {
    const preload = '--import=data:text/javascript,process.exit(3)'
    const bypasses = [
      // Astra round 4.
      command('node', '--test', '__missing_repro__.test.js'),
      command('node', '--test', '--help'),
      command('env', '-C', 'docs/reference', 'node', '--test'),
      command('env', `NODE_OPTIONS=${preload}`, 'node', '--test'),
      // Grok F1-F8.
      command('pnpm', 'test', '-C/tmp'),
      command('pytest', '-c/tmp/pytest.ini'),
      command('make', 'test', '-C..'),
      command('env', 'PATH=/tmp/evil:$PATH', 'pytest'),
      command('env', '-C', '/tmp', 'pytest'),
      command('sudo', '-D', '/tmp', 'pytest'),
      command('npx', '-p', 'evil-pkg', 'vitest'),
      command('pnpm', 'dlx', 'vitest'),
      command('pytest', '--override-ini=testpaths=/tmp/passing'),
      command('pytest', 'tests\u0000'),
      command('go', 'test', '-toolexec=bin/fake', './...'),
      // Earlier rounds.
      command('awk', 'BEGIN {exit 3}', 'package.json'),
      command('make', '-f', '/dev/null', '__missing_target__'),
      command('cat', 'plan.md'),
      command('/tmp/vitest', 'run'),
      command('node', '-e', 'process.exit(3)'),
      command('sh', '-c', "printf 'ka%s' boom; exit 1"),
      { ...command('make', '--version'), expect: 'output' as const, output: 'GNU Make' }
    ]
    const checks = host()
    for (const evidence of bypasses) {
      expect(await statusOf(evidence, checks), evidence.args.join(' ')).toBe('located')
    }
  })

  it('leaves a command that could prove itself, or an unusable expected output, unverified', async () => {
    for (const evidence of [
      { ...command('echo', 'boom'), expect: 'output' as const, output: 'boom' },
      command('/usr/bin/false'),
      command('false.cmd'),
      command('C:\\tools\\true.ps1'),
      {
        ...command('node', '-e', "require('assert').fail('plan is unsafe')"),
        output: 'plan is unsafe'
      },
      { ...command('node', 'x.js'), outputInvalid: true as const }
    ]) {
      expect(await statusOf(evidence), evidence.program).toBe('unverified')
    }
  })
})

describe('checkReviewFinding: named tests', () => {
  it('locates a named test without running it, whatever it names', async () => {
    const checks = host()
    for (const evidence of [
      { kind: 'test' as const, file: 'add.test.js', name: 'adds' },
      // Astra round 5.
      { kind: 'test' as const, file: 'tests/add.rs', name: '--manifest-path=/outside/Cargo.toml' },
      { kind: 'test' as const, file: 'pkg/windows_test.go' },
      { kind: 'test' as const, file: 'a\\..\\..\\outside.py' },
      { kind: 'test' as const, file: 'cached_test.go', name: 'TestCached' },
      { kind: 'test' as const, file: 'empty.test.js' },
      { kind: 'test' as const, file: '../outside.test.js' }
    ]) {
      const checked = await checkReviewFinding(blocker(evidence), checks)
      expect(checked, evidence.file).toMatchObject({
        status: 'located',
        detail: 'Commands and named tests are not run; the finding still blocks.'
      })
    }
  })
})

describe('checkReviewFinding: quotes', () => {
  const quote = (text: string, file?: string): ReviewEvidence => ({
    kind: 'quote',
    text,
    ...(file ? { file } : {})
  })

  it('locates a quote in the candidate (never confirms) and keeps blocking on one it cannot find', async () => {
    expect(await statusOf(quote('deploy on Friday night'))).toBe('located')
    // A quote the host cannot find keeps blocking: a misquoted real bug must not pass.
    expect(await statusOf(quote('Saturday'))).toBe('unverified')
    const misquoted = await checkReviewFinding(
      blocker(quote('deploy on friday night', 'plan.md')),
      host()
    )
    expect(misquoted).toMatchObject({
      status: 'unverified',
      detail: 'The quoted text was not found in the file; the finding still blocks'
    })
    expect(reviewFindingBlocks(misquoted)).toBe(true)
  })

  it('leaves a quote it could not read in full unverified', async () => {
    await writeFile(join(workspace, 'huge.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 97))
    expect(await statusOf(quote('root', '../../../../../../etc/passwd'))).toBe('unverified')
    expect(await statusOf(quote('Saturday', 'docs'))).toBe('unverified')
    expect(await statusOf(quote('Saturday', 'missing.md'))).toBe('unverified')
    expect(await statusOf(quote('Saturday', 'huge.txt'))).toBe('unverified')
    expect(await statusOf(quote('Saturday'), host([]))).toBe('unverified')
    expect(await statusOf(quote('Saturday'), host(['plan.md', 'gone.md']))).toBe('unverified')
  })
})

describe('checkReviewFindings', () => {
  it('leaves evidence it cannot run here unverified, which still blocks', async () => {
    const remote = { workspacePath: null, files: [] }
    const failing = { kind: 'test' as const, file: 'add.test.js' }
    expect(await statusOf(failing, remote)).toBe('unverified')
    expect(
      await statusOf({ kind: 'command', program: 'node', args: ['x.js'], expect: 'fail' }, remote)
    ).toBe('unverified')
  })

  it('asks for evidence a blocker lacks and checks only blockers', async () => {
    const [bare, major] = await checkReviewFindings(
      [blocker(undefined), { id: 'F2', severity: 'major', claim: 'slow' }],
      host()
    )
    expect(bare!.status).toBe('needs-evidence')
    expect(major!.status).toBe('needs-evidence')
  })
})

describe('fresh results', () => {
  it('always block a blocker that carries evidence', async () => {
    const evidence: ReviewEvidence[] = [
      { kind: 'quote', text: 'deploy on Friday night' },
      { kind: 'quote', text: 'deploy on Friday night', file: 'plan.md' },
      { kind: 'quote', text: 'Saturday' },
      { kind: 'quote', text: 'Saturday', file: 'plan.md' },
      { kind: 'quote', text: 'Saturday', file: 'docs' },
      { kind: 'quote', text: 'Saturday', file: '../outside.md' },
      { kind: 'test', file: 'add.test.js', name: 'adds' },
      { kind: 'command', program: 'node', args: ['x.js'], expect: 'fail' },
      { kind: 'command', program: 'echo', args: ['boom'], expect: 'output', output: 'boom' },
      { kind: 'command', program: 'node', args: ['x.js'], expect: 'fail', outputInvalid: true }
    ]
    const remote = { workspacePath: null, files: [] }
    for (const item of evidence) {
      for (const checks of [host(), host([]), remote]) {
        const checked = await checkReviewFinding(blocker(item), checks)
        expect(checked.status, JSON.stringify(item)).not.toBe('not-reproduced')
        expect(reviewFindingBlocks(checked), JSON.stringify(item)).toBe(true)
      }
    }
  })
})
