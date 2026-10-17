import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from '../git/runner'
import { consoleJobExecutionBrief } from './console-job-launch'
import { createConsoleLocalExecutionFixture } from './console-local-execution-test-fixture'
import { prepareConsoleJobWorktree } from './console-job-worktree'
import {
  assertConsoleLoopVerdictContract,
  consoleLoopVerdictRelativePath,
  consoleLoopVerdictRequired,
  readConsoleLoopVerdict
} from './console-loop-verdict'

describe('canonical loop candidate and verdict materialization', () => {
  const fixtures: Awaited<ReturnType<typeof createConsoleLocalExecutionFixture>>[] = []

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      fixture.service.dispose()
      fixture.db.close()
      await rm(fixture.directory, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  })

  async function fixture() {
    const value = await createConsoleLocalExecutionFixture()
    fixtures.push(value)
    return value
  }

  async function commitCandidate(
    value: Awaited<ReturnType<typeof createConsoleLocalExecutionFixture>>,
    content: string
  ) {
    await writeFile(join(value.cwd, 'README.md'), content)
    await gitExecFileAsync(['add', 'README.md'], { cwd: value.cwd })
    await gitExecFileAsync(['commit', '-m', 'producer candidate'], { cwd: value.cwd })
    return (await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: value.cwd })).stdout.trim()
  }

  function loopJob(
    value: Awaited<ReturnType<typeof createConsoleLocalExecutionFixture>>,
    action: 'review' | 'repair',
    candidateSha: string
  ) {
    value.job.action = action
    value.job.readOnly = action === 'review'
    value.job.inputs = [
      {
        loop_stage: { key: `${action}-1`, role: action, round: 1 },
        producer: { key: 'producer', job_id: 'job_producer', candidate_sha: candidateSha }
      }
    ]
    return value.job
  }

  it.each(['review', 'repair'] as const)(
    'starts a %s at the producer commit rather than the root frozen base',
    async (action) => {
      const value = await fixture()
      const candidate = await commitCandidate(value, `${action} candidate\n`)
      const worktree = await prepareConsoleJobWorktree(
        value.runtime,
        (await value.runtime.showRepo('repo')) as never,
        loopJob(value, action, candidate)
      )
      expect(worktree.startSha).toBe(candidate)
      expect(await readFile(join(worktree.path, 'README.md'), 'utf8')).toBe(`${action} candidate\n`)
    }
  )

  it('preserves a generic review without canonical loop inputs', async () => {
    const value = await fixture()
    value.job.action = 'review'
    value.job.readOnly = true
    const worktree = await prepareConsoleJobWorktree(
      value.runtime,
      (await value.runtime.showRepo('repo')) as never,
      value.job
    )
    expect(worktree.startSha).toBe(value.job.baseSha)
  })

  it('permits only graph-owned verdict reporting in a read-only loop review brief', async () => {
    const value = await fixture()
    const job = loopJob(value, 'review', value.job.baseSha!)
    job.ownedPaths = ['workflow-loops/review-1/**']
    const activated = await value.port.activate({
      jobId: job.id,
      workflowId: job.workflowId,
      approvedDigest: job.digest,
      worktree: 'id:source'
    })
    expect(activated.ok).toBe(true)
    if (!activated.ok) {
      return
    }

    const brief = consoleJobExecutionBrief(activated.data, (text) => text)
    expect(brief).toContain(
      'Read only: do not edit reviewed source, commit, push, publish a review, or send messages to people.'
    )
    expect(brief).toContain(
      'Control-plane reporting only: write the exact graph-owned verdict metadata file at workflow-loops/review-1/verdict.json and send the required worker_done to the coordinator.'
    )
    expect(brief).not.toContain(
      'no edits, commits, pushes, review requests, messages or external writes'
    )
  })

  it('preserves the legacy branch fallback when no frozen base SHA is supplied', async () => {
    const value = await fixture()
    value.job.baseSha = undefined
    value.job.baseBranch = (
      await gitExecFileAsync(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: value.cwd })
    ).stdout.trim()
    const expected = (
      await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: value.cwd })
    ).stdout.trim()
    const worktree = await prepareConsoleJobWorktree(
      value.runtime,
      (await value.runtime.showRepo('repo')) as never,
      value.job
    )
    expect(worktree.startSha).toBe(expected)
  })

  it('rejects an existing successor worktree pinned to a stale candidate', async () => {
    const value = await fixture()
    const base = value.job.baseSha!
    await prepareConsoleJobWorktree(
      value.runtime,
      (await value.runtime.showRepo('repo')) as never,
      value.job
    )
    const candidate = await commitCandidate(value, 'new candidate\n')
    vi.mocked(value.runtime.listManagedWorktrees).mockResolvedValue({
      worktrees: [
        {
          id: 'job-worktree',
          repoId: 'repo',
          hostId: 'local',
          git: { path: join(value.directory, 'job'), branch: `omni/${value.job.id}` }
        }
      ],
      truncated: false
    } as never)
    expect(base).not.toBe(candidate)
    const job = loopJob(value, 'review', candidate)
    job.revision = {
      confirmed: true,
      branch: `omni/${job.id}`,
      reviewUrl: 'https://gitlab.example/team/project/-/merge_requests/1',
      reviewNumber: 1
    }
    await expect(
      prepareConsoleJobWorktree(value.runtime, (await value.runtime.showRepo('repo')) as never, job)
    ).rejects.toThrow('immutable producer candidate')
  })

  it('recovers a confirmed clean repair only when its head descends from the producer', async () => {
    const value = await fixture()
    const candidate = await commitCandidate(value, 'producer candidate\n')
    const job = loopJob(value, 'repair', candidate)
    const first = await prepareConsoleJobWorktree(
      value.runtime,
      (await value.runtime.showRepo('repo')) as never,
      job
    )
    await writeFile(join(first.path, 'README.md'), 'repaired candidate\n')
    await gitExecFileAsync(['add', 'README.md'], { cwd: first.path })
    await gitExecFileAsync(['commit', '-m', 'repair candidate'], { cwd: first.path })
    const repaired = (
      await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: first.path })
    ).stdout.trim()
    job.revision = {
      confirmed: true,
      branch: first.branch!,
      reviewUrl: 'https://gitlab.example/team/project/-/merge_requests/2',
      reviewNumber: 2
    }
    vi.mocked(value.runtime.listManagedWorktrees).mockResolvedValue({
      worktrees: [
        {
          id: first.id,
          repoId: 'repo',
          hostId: 'local',
          git: { path: first.path, branch: first.branch! }
        }
      ],
      truncated: false
    } as never)
    expect(
      await prepareConsoleJobWorktree(
        value.runtime,
        (await value.runtime.showRepo('repo')) as never,
        job
      )
    ).toMatchObject({ startSha: repaired, path: first.path })
  })

  it('rejects a confirmed repair whose existing head predates the producer', async () => {
    const value = await fixture()
    const base = value.job.baseSha!
    const first = await prepareConsoleJobWorktree(
      value.runtime,
      (await value.runtime.showRepo('repo')) as never,
      value.job
    )
    const candidate = await commitCandidate(value, 'later producer\n')
    const job = loopJob(value, 'repair', candidate)
    job.revision = {
      confirmed: true,
      branch: first.branch!,
      reviewUrl: 'https://gitlab.example/team/project/-/merge_requests/3',
      reviewNumber: 3
    }
    vi.mocked(value.runtime.listManagedWorktrees).mockResolvedValue({
      worktrees: [
        {
          id: first.id,
          repoId: 'repo',
          hostId: 'local',
          git: { path: first.path, branch: first.branch! }
        }
      ],
      truncated: false
    } as never)
    expect(base).not.toBe(candidate)
    await expect(
      prepareConsoleJobWorktree(value.runtime, (await value.runtime.showRepo('repo')) as never, job)
    ).rejects.toThrow('does not descend')
  })

  it('accepts only the actual bounded canonical verdict file', async () => {
    const value = await fixture()
    const candidate = await commitCandidate(value, 'review candidate\n')
    const job = loopJob(value, 'review', candidate)
    job.ownedPaths = ['workflow-loops/review-1/**']
    const root = join(value.cwd, 'workflow-loops/review-1')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'verdict.json'), '{"verdict":"pass"}')
    expect(await readConsoleLoopVerdict(job, value.cwd)).toBeNull()
    await writeFile(
      join(root, 'verdict.json'),
      JSON.stringify({
        verdict: 'agree',
        blockers: 'not-an-array',
        gaps: [],
        notes: 'Malformed blockers must not close zero_blockers.'
      })
    )
    expect(await readConsoleLoopVerdict(job, value.cwd)).toBeNull()
    await writeFile(
      join(root, 'verdict.json'),
      JSON.stringify({
        verdict: 'agree',
        blockers: Array.from({ length: 33 }, (_, index) => `blocker-${index}`),
        gaps: [],
        notes: 'A finding after the bound must not be dropped.'
      })
    )
    expect(await readConsoleLoopVerdict(job, value.cwd)).toBeNull()
    await writeFile(
      join(root, 'verdict.json'),
      JSON.stringify({
        verdict: 'agree',
        blockers: [],
        gaps: ['verified candidate'],
        notes: 'Reviewed exact producer bytes'
      })
    )
    expect(await readConsoleLoopVerdict(job, value.cwd)).toEqual({
      verdict: 'agree',
      blockers: [],
      gaps: ['verified candidate'],
      notes: 'Reviewed exact producer bytes'
    })
  })

  it('keeps the verdict protocol path POSIX and admits no path for native separators or escapes', async () => {
    const value = await fixture()
    const job = loopJob(value, 'review', value.job.baseSha!)
    job.ownedPaths = ['workflow-loops/review-1/**']
    expect(consoleLoopVerdictRelativePath(job)).toBe('workflow-loops/review-1/verdict.json')
    expect(() => assertConsoleLoopVerdictContract(job)).not.toThrow()
    for (const ownedPaths of [['workflow-loops\\review-1/**'], ['../review-1/**'], null, []]) {
      job.ownedPaths = ownedPaths
      expect(consoleLoopVerdictRequired(job)).toBe(true)
      expect(consoleLoopVerdictRelativePath(job)).toBeNull()
      expect(() => assertConsoleLoopVerdictContract(job)).toThrow(
        'no single canonical verdict directory'
      )
    }
    job.action = 'execute'
    expect(consoleLoopVerdictRequired(job)).toBe(false)
    expect(() => assertConsoleLoopVerdictContract(job)).not.toThrow()
  })
})
