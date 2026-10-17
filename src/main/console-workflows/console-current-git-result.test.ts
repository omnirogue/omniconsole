import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runConsoleJobAcceptance } from './console-job-acceptance'
import { consoleJobOutputDigest } from './console-job-digests'
import { materializeConsoleCurrentGitSource } from './console-current-git-materialization'
import {
  consoleFolderRoundArtifact,
  hydrateConsoleFolderCandidate
} from './console-folder-round-snapshot'
import {
  createConsoleCurrentGitFixture,
  currentGitAcceptedCandidate,
  currentGitActivation,
  currentGitExitProof
} from './console-current-git-test-fixture'

describe('Git selection result evidence', () => {
  let f: Awaited<ReturnType<typeof createConsoleCurrentGitFixture>>
  let worktree: Awaited<ReturnType<typeof f.worktree>>
  beforeEach(async () => {
    f = await createConsoleCurrentGitFixture()
    worktree = await f.worktree()
    await materializeConsoleCurrentGitSource(f.job, worktree.path, f.preparedInputPaths)
  })
  afterEach(async () => {
    await rm(f.directory, { recursive: true, force: true })
  })

  const acceptance = () =>
    runConsoleJobAcceptance({
      job: f.job,
      cwd: worktree.path,
      startSha: worktree.startSha,
      branch: worktree.branch,
      workerSucceeded: true,
      processProof: currentGitExitProof,
      sanitize: (value) => value
    })

  it('accepts a read-only review against selected dirty bytes despite the diff from HEAD', async () => {
    await mkdir(join(worktree.path, 'workflow-loops/review-selected'), { recursive: true })
    await writeFile(
      join(worktree.path, 'workflow-loops/review-selected/verdict.json'),
      '{"verdict":"agree","blockers":[],"gaps":[],"notes":"Checked selected bytes"}'
    )
    expect((await f.git(['diff', '--name-only', 'HEAD'], worktree.path)).stdout).toContain(
      'selected.txt'
    )
    const result = await acceptance()
    expect(result).toMatchObject({
      status: 'done',
      result_exit_code: 0,
      candidate_sha: null,
      branch: null,
      pr_url: null,
      pr_number: null,
      changed_files: ['deleted.txt', 'outputs/new.txt', 'selected.txt'],
      owned_paths_violations: [],
      terminal_proof: currentGitExitProof
    })
    expect(result.output_digest).toBe(consoleJobOutputDigest(result))
    const report = await consoleFolderRoundArtifact(f.job, 1, worktree.path, {
      ...result,
      worker_report: 'Reviewed the captured dirty files and explicit deletion.'
    })
    expect(JSON.parse(Buffer.from(report.contentBase64, 'base64').toString())).toMatchObject({
      candidate_sha: null,
      branch: null,
      pr_url: null,
      reviewed_snapshot: {
        kind: 'current_task_files',
        snapshot_digest: f.input.current_source.snapshot_digest
      }
    })
  })

  it.each(['selected.txt', 'untouched.txt', 'new-unselected.txt', 'deleted.txt'])(
    'fails a reviewer mutation at %s',
    async (path) => {
      await writeFile(join(worktree.path, path), 'unauthorized reviewer edit\n')
      expect(await acceptance()).toMatchObject({
        status: 'failed',
        candidate_sha: null,
        branch: null,
        pr_url: null,
        owned_paths_violations: [path]
      })
    }
  )

  it('fails a reviewer commit even when committed selected bytes equal the capture', async () => {
    await f.git(['add', '.'], worktree.path)
    await f.git(['commit', '-m', 'unexpected reviewer commit'], worktree.path)
    expect((await f.git(['status', '--porcelain'], worktree.path)).stdout).toBe('')
    expect(await acceptance()).toMatchObject({
      status: 'failed',
      candidate_sha: null,
      branch: null,
      pr_url: null,
      owned_paths_violations: [],
      output_tail: expect.stringContaining('captured Git HEAD')
    })
  })

  it('reviews the accepted repair generation and fails if the worker restores the original capture', async () => {
    await writeFile(join(worktree.path, 'selected.txt'), 'accepted repaired source\n')
    await rm(join(worktree.path, 'outputs/new.txt'))
    const { artifact, candidate } = await currentGitAcceptedCandidate(f.job, worktree.path)
    f.input.loop_stage.round = 2
    f.input.source_overlay = false
    Object.assign(f.input, { folder_candidate: candidate })
    worktree = await f.worktree('round2')
    await hydrateConsoleFolderCandidate({
      activation: currentGitActivation(f.job),
      workspacePath: worktree.path,
      candidate,
      contentBase64: artifact.contentBase64
    })
    const result = await acceptance()
    expect(result).toMatchObject({
      status: 'done',
      owned_paths_violations: [],
      candidate_sha: null
    })
    const review = await consoleFolderRoundArtifact(f.job, 2, worktree.path, {
      ...result,
      worker_report: 'Reviewed the accepted repair snapshot.'
    })
    expect(JSON.parse(Buffer.from(review.contentBase64, 'base64').toString())).toMatchObject({
      reviewed_snapshot: {
        kind: 'accepted_folder_snapshot',
        snapshot_digest: candidate.snapshot_digest,
        artifact_sha256: candidate.artifact.sha256,
        source_job_id: candidate.job_id,
        source_attempt: candidate.attempt
      }
    })
    await writeFile(join(worktree.path, 'selected.txt'), await readFile(f.preparedInputPaths[1]!))
    expect(await acceptance()).toMatchObject({
      status: 'failed',
      owned_paths_violations: ['selected.txt']
    })
  })

  it('allows repair changes within the captured selection without treating them as a committed candidate', async () => {
    f.job.action = 'repair'
    f.job.readOnly = false
    f.job.artifactResult!.path = 'folder-snapshot.json'
    f.input.loop_stage.role = 'repair'
    f.job.ownedPaths = ['deleted.txt', 'outputs/new.txt', 'selected.txt']
    await writeFile(join(worktree.path, 'selected.txt'), 'repaired dirty source\n')
    await rm(join(worktree.path, 'outputs/new.txt'))
    expect(await acceptance()).toMatchObject({
      status: 'done',
      candidate_sha: null,
      branch: null,
      pr_url: null,
      owned_paths_violations: []
    })
  })

  it('preserves the committed-candidate acceptance contract for a Git artifact without current_source', async () => {
    f.job.action = 'execute'
    f.job.readOnly = false
    f.job.inputs = ['ordinary Git task']
    f.job.ownedPaths = ['deleted.txt', 'outputs/new.txt', 'selected.txt']
    f.job.artifactResult!.path = 'work-result.json'
    expect(await acceptance()).toMatchObject({
      status: 'failed',
      candidate_sha: worktree.startSha,
      branch: worktree.branch,
      output_tail: expect.stringContaining('Commit repository changes')
    })
    await f.git(['add', '.'], worktree.path)
    await f.git(['commit', '-m', 'ordinary committed result'], worktree.path)
    const head = (await f.git(['rev-parse', 'HEAD'], worktree.path)).stdout.trim()
    expect(await acceptance()).toMatchObject({
      status: 'done',
      candidate_sha: head,
      branch: worktree.branch,
      owned_paths_violations: []
    })
  })
})
