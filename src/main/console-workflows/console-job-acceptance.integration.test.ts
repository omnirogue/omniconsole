import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from '../git/runner'
import { consoleJobOutputDigest, runConsoleJobAcceptance } from './console-job-acceptance'
import { consoleJobPathViolations, snapshotConsoleJobChanges } from './console-job-changes'
import { publishConsoleJobReview } from './console-job-review'
import type { ConsoleLocalJob, ConsoleLocalResult } from './console-local-execution-contract'

describe('console job acceptance against a real Git worktree', () => {
  let cwd: string
  let startSha: string
  const git = (args: string[]) => gitExecFileAsync(args, { cwd })
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'console-job-'))
    await git(['init'])
    await git(['checkout', '-b', 'omni/job_fixture'])
    await git(['config', 'user.name', 'Acceptance test'])
    await git(['config', 'user.email', 'acceptance@example.invalid'])
    await mkdir(join(cwd, 'src'))
    await writeFile(join(cwd, 'src', 'base.txt'), 'base\n')
    await git(['add', '.'])
    await git(['commit', '-m', 'baseline'])
    startSha = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  const job = (overrides: Partial<ConsoleLocalJob> = {}): ConsoleLocalJob => ({
    id: 'job_fixture',
    taskId: 'btk_fixture',
    workflowId: 'wf_fixture',
    digest: 'a'.repeat(64),
    state: 'ready',
    placement: 'local',
    provider: 'codex',
    model: 'gpt-6',
    title: 'Fixture',
    repo: 'gitlab.example/team/project',
    baseBranch: 'main',
    prompt: 'Build the requested change.',
    brief: 'Bounded change',
    acceptance: 'The acceptance process exits successfully.',
    inputs: [],
    ownedPaths: ['src/**'],
    readOnly: false,
    reviewProvider: 'gitlab',
    acceptanceCommands: [
      { program: process.execPath, args: ['-e', 'console.log("accepted")'], timeoutMs: 5000 }
    ],
    ...overrides
  })
  const accept = (overrides: Partial<ConsoleLocalJob> = {}, sanitize = (value: string) => value) =>
    runConsoleJobAcceptance({
      job: job(overrides),
      cwd,
      startSha,
      branch: 'omni/job_fixture',
      workerSucceeded: true,
      sanitize
    })

  it('includes committed, staged, unstaged, untracked and renamed paths', async () => {
    await writeFile(join(cwd, 'outside.txt'), 'committed\n')
    await git(['add', 'outside.txt'])
    await git(['commit', '-m', 'committed violation'])
    await git(['mv', 'src/base.txt', 'src/renamed.txt'])
    await writeFile(join(cwd, 'src', 'renamed.txt'), 'unstaged\n')
    await writeFile(join(cwd, 'new.txt'), 'untracked\n')
    expect(await snapshotConsoleJobChanges(cwd, startSha)).toEqual([
      'new.txt',
      'outside.txt',
      'src/base.txt',
      'src/renamed.txt'
    ])
    const result = await accept()
    expect(result.status).toBe('failed')
    expect(result.exit_code).toBe(0)
    expect(result.owned_paths_violations).toEqual(['new.txt', 'outside.txt'])
    expect(result.output_tail).toContain('accepted')
  })

  it('rejects outside-scope writes even when a later commit reverts them', async () => {
    await writeFile(join(cwd, 'outside.txt'), 'temporary out-of-scope edit')
    await git(['add', 'outside.txt'])
    await git(['commit', '-m', 'outside scope'])
    await git(['revert', '--no-edit', 'HEAD'])
    const result = await accept()
    expect(result.status).toBe('failed')
    expect(result.owned_paths_violations).toEqual(['outside.txt'])
  })

  it('refuses a successful check when it verified a dirty candidate', async () => {
    await writeFile(join(cwd, 'src', 'base.txt'), 'uncommitted input')
    expect((await accept()).status).toBe('failed')
  })

  it('refuses evidence when acceptance itself advances HEAD', async () => {
    const result = await accept({
      acceptanceCommands: [
        {
          program: 'git',
          args: ['commit', '--allow-empty', '-m', 'changed during acceptance'],
          timeoutMs: 5000
        }
      ]
    })
    expect(result.exit_code).toBe(0)
    expect(result.status).toBe('failed')
    expect(result.candidate_sha).toBe(startSha)
  })

  it.each(['head', 'branch', 'digest'] as const)(
    'refuses publication with a mismatched %s',
    async (change) => {
      const result = await accept()
      expect(result.status).toBe('done')
      if (change === 'head') {
        await git(['commit', '--allow-empty', '-m', 'new head'])
      }
      if (change === 'branch') {
        await git(['checkout', '-b', 'other'])
      }
      if (change === 'digest') {
        result.changed_files.push('invented.txt')
      }
      const services = {
        gitPush: vi.fn(),
        createHostedReview: vi.fn().mockResolvedValue({
          ok: true,
          number: 9,
          url: 'https://gitlab.example/team/project/-/merge_requests/9'
        }),
        getHostedReviewForBranch: vi.fn()
      }
      await expect(publishConsoleJobReview(job(), cwd, result, services)).rejects.toThrow(/match/)
      expect(services.gitPush).not.toHaveBeenCalled()
      expect(services.createHostedReview).not.toHaveBeenCalled()
    }
  )

  it('fails read-only results even when the worker committed its change', async () => {
    await writeFile(join(cwd, 'src', 'base.txt'), 'changed\n')
    await git(['add', '.'])
    await git(['commit', '-m', 'unexpected edit'])
    const result = await accept({ readOnly: true })
    expect(result.status).toBe('failed')
    expect(result.owned_paths_violations).toEqual(['src/base.txt'])
  })

  it('refuses credentials in an earlier unpublished commit even after the worker removes them', async () => {
    const protectedValue = ['ghp_', 'z'.repeat(36)].join('')
    await writeFile(join(cwd, 'src', 'base.txt'), protectedValue)
    await git(['add', '.'])
    await git(['commit', '-m', 'introduce protected fixture'])
    await writeFile(join(cwd, 'src', 'base.txt'), 'clean final tree')
    await git(['add', '.'])
    await git(['commit', '-m', 'remove protected fixture'])
    const result = await accept()
    expect(result.status).toBe('failed')
    expect(result.result_exit_code).toBe(0)
    expect(result.output_tail).toContain('credential inspection')
    expect(JSON.stringify(result)).not.toContain(protectedValue)
    const services = {
      gitPush: vi.fn(),
      createHostedReview: vi.fn(),
      getHostedReviewForBranch: vi.fn()
    }
    await publishConsoleJobReview(job(), cwd, result, services)
    expect(services.gitPush).not.toHaveBeenCalled()
    expect(services.createHostedReview).not.toHaveBeenCalled()
  })

  it('runs server acceptance and retains the real nonzero exit and bounded output', async () => {
    const result = await accept({
      acceptanceCommands: [
        {
          program: process.execPath,
          args: ['-e', 'console.error("acceptance refused"); process.exit(7)'],
          timeoutMs: 5000
        }
      ]
    })
    expect(result.status).toBe('failed')
    expect(result.exit_code).toBe(7)
    expect(result.result_exit_code).toBe(7)
    expect(result.output_tail).toContain('acceptance refused')
    expect((await accept({ acceptanceCommands: [] })).status).toBe('failed')
    const chatty = await accept({
      acceptanceCommands: [
        {
          program: process.execPath,
          args: ['-e', 'console.log("prefix" + "x".repeat(100000) + "final-tail")'],
          timeoutMs: 5000
        }
      ]
    })
    expect(chatty.output_tail).toContain('final-tail')
    expect(chatty.output_tail.length).toBeLessThanOrEqual(16_000)
  })

  it('redacts captured secrets and refuses to execute a command containing the bearer', async () => {
    const sentinel = 'opaque-console-credential-sentinel'
    const sanitize = (value: string) => value.replaceAll(sentinel, '[redacted]')
    const result = await accept(
      {
        acceptanceCommands: [
          {
            program: process.execPath,
            args: ['-e', `require('fs').writeFileSync('must-not-run', '${sentinel}')`],
            timeoutMs: 5000
          }
        ]
      },
      sanitize
    )
    expect(result.status).toBe('failed')
    expect(JSON.stringify(result)).not.toContain(sentinel)
    await expect(readFile(join(cwd, 'must-not-run'))).rejects.toThrow()
    expect((await git(['config', '--local', '--list'])).stdout).not.toContain(sentinel)
  })

  it('reuses the confirmed revision branch and GitLab MR without creating another review', async () => {
    const revision = {
      confirmed: true,
      branch: 'omni/job_prior',
      reviewUrl: 'https://gitlab.example/team/project/-/merge_requests/4',
      reviewNumber: 4
    }
    await git(['checkout', '-b', revision.branch])
    const result = await runConsoleJobAcceptance({
      job: job({ revision }),
      cwd,
      startSha,
      branch: revision.branch,
      workerSucceeded: true,
      sanitize: (value) => value
    })
    const services = {
      gitPush: vi.fn().mockResolvedValue(undefined),
      createHostedReview: vi.fn(),
      getHostedReviewForBranch: vi
        .fn()
        .mockResolvedValue({ url: revision.reviewUrl, number: 4, state: 'open' })
    }
    const published = await publishConsoleJobReview(job({ revision }), cwd, result, services)
    expect(published).toMatchObject({
      status: 'pr_open',
      branch: revision.branch,
      pr_url: revision.reviewUrl,
      pr_number: 4
    })
    expect(services.gitPush).toHaveBeenCalledOnce()
    expect(services.createHostedReview).not.toHaveBeenCalled()
    expect(published.output_digest).toBe(consoleJobOutputDigest(published))
  })

  it('treats scope changes as digest changes and refuses traversal or absolute paths', async () => {
    const result = await accept()
    expect(consoleJobOutputDigest({ ...result, changed_files: ['src/new.txt'] })).not.toBe(
      result.output_digest
    )
    expect(consoleJobOutputDigest({ ...result, owned_paths_violations: ['private.txt'] })).not.toBe(
      result.output_digest
    )
    expect(
      consoleJobPathViolations(
        ['../escape', '/absolute', 'src/good.ts', 'C:\\escape'],
        ['src/**'],
        false
      )
    ).toEqual(['../escape', '/absolute', 'C:\\escape'])
    expect(consoleJobPathViolations(['src/nested/file.ts'], ['src/*.ts'], false)).toEqual([
      'src/nested/file.ts'
    ])
  })

  it('matches the verified Lane 2 canonical result digest and literal glob semantics', async () => {
    const result = {
      ...(await accept()),
      result_exit_code: undefined,
      candidate_sha: 'a'.repeat(40),
      branch: 'omni/job_fixture01',
      changed_files: ['src/z.ts', 'src/a.ts', 'src/a.ts'],
      owned_paths_violations: []
    }
    // Generated with Lane 2 ledger_digests.output_digest on 2026-09-08.
    expect(consoleJobOutputDigest(result)).toBe(
      '2a664f09cc83077aa3b1f3c0a4fe264d1cca9fb5415eb16f5bcd4c36809ea245'
    )
    expect(
      consoleJobOutputDigest({
        ...result,
        candidate_sha: null,
        branch: 'omni/job_test',
        changed_files: ['\uE000', '\u{1F600}']
      })
    ).toBe('5724d538619268ca9b86779f68beaddf57bdbecf9804093ffabc4c389217e556')
    expect(
      consoleJobPathViolations(['src/a.ts', 'src/b.ts', 'src/{a,b}.ts'], ['src/{a,b}.ts'], false)
    ).toEqual(['src/a.ts', 'src/b.ts'])
    expect(
      consoleJobPathViolations(['src/a.ts', 'src/nested/a.ts'], ['src/[ab].ts'], false)
    ).toEqual(['src/nested/a.ts'])
  })

  it('keeps the independently observed acceptance exit separate from the registered process exit', async () => {
    const result: ConsoleLocalResult = {
      ...(await accept()),
      candidate_sha: 'a'.repeat(40),
      branch: 'omni/job_fixture',
      changed_files: ['src/\u{1F600}.ts', 'src/\uE000.ts', 'src/\u{1F600}.ts'],
      terminal_proof: {
        kind: 'exited',
        process_identity: {
          pid: 123,
          started_at: '2026-09-08T23:00:00Z',
          runner_instance: 'orca_instance_123'
        },
        process_exited: true,
        process_exit_code: 37,
        exit_cause: { kind: 'exited', exit_code: 37 },
        observed_at: '2026-09-08T23:01:00Z'
      }
    }
    expect(result.result_exit_code).toBe(0)
    // Executed against Lane 2 c3da327 ledger_digests.output_digest.
    expect(consoleJobOutputDigest(result)).toBe(
      'f493b06569effbc72fc6394072ae15c3470bbcf166e365b8024a504514aa32dc'
    )
    expect(consoleJobOutputDigest({ ...result, result_exit_code: 7 })).not.toBe(
      consoleJobOutputDigest(result)
    )
  })

  it('does not fabricate an acceptance exit code from a worker failure', async () => {
    const result = await runConsoleJobAcceptance({
      job: job(),
      cwd,
      startSha,
      branch: 'omni/job_fixture',
      workerSucceeded: false,
      sanitize: (text) => text
    })
    expect(result.status).toBe('failed')
    expect(result.exit_code).toBeNull()
    expect(result.result_exit_code).toBeUndefined()
    expect(result.output_tail).toContain('acceptance was not executed')
  })
})
