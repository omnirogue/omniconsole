import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { gitExecFileAsync } from '../git/runner'
import { consoleJobClaimFixture } from '../runtime/orchestration/console-job-test-fixture'
import { canonicalDigestJson } from './console-job-digests'
import {
  consoleFolderRoundArtifact,
  type ConsoleFolderCandidate
} from './console-folder-round-snapshot'
import type {
  ConsoleLocalActivation,
  ConsoleLocalJob,
  ConsoleLocalResult,
  ConsoleLocalTerminalProof
} from './console-local-execution-contract'
import type { ConsoleConversationFleetSourceFile } from '../../shared/console-conversation-fleet-types'

export const currentGitSha = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex')

export const currentGitExitProof: ConsoleLocalTerminalProof = {
  kind: 'exited',
  process_identity: {
    pid: 311,
    started_at: '2026-09-15T00:00:00Z',
    runner_instance: 'orca_worker_00001'
  },
  process_exited: true,
  process_exit_code: 0,
  exit_cause: { kind: 'exited', exit_code: 0 },
  observed_at: '2026-09-15T00:00:01Z'
}

export const currentGitWorkerResult: ConsoleLocalResult = {
  status: 'done',
  exit_code: 0,
  worker_report: 'Reviewed and repaired the selected files.',
  output_tail: 'Snapshot ready for independent verification.',
  candidate_sha: null,
  branch: null,
  pr_url: null,
  pr_number: null,
  changed_files: [],
  owned_paths_violations: [],
  terminal_proof: currentGitExitProof,
  output_digest: 'c'.repeat(64)
}

export function currentGitActivation(job: ConsoleLocalJob): ConsoleLocalActivation {
  return {
    job,
    principal: 'a'.repeat(64),
    binding: {
      ...consoleJobClaimFixture,
      jobId: job.id,
      taskId: job.taskId,
      workflowId: job.workflowId
    }
  }
}

export async function createConsoleCurrentGitFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'console-current-git-')))
  const cwd = join(directory, 'source')
  const git = (args: string[], path = cwd) => gitExecFileAsync(args, { cwd: path })
  await gitExecFileAsync(['init', cwd], { cwd: directory })
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await git(['config', 'user.name', 'Snapshot test'])
  await git(['config', 'user.email', 'snapshot@example.invalid'])
  await git(['config', 'core.autocrlf', 'false'])
  await git(['remote', 'add', 'origin', 'https://gitlab.example/team/project.git'])
  await writeFile(join(cwd, 'selected.txt'), 'committed source\n')
  await writeFile(join(cwd, 'deleted.txt'), 'committed deletion\n')
  await writeFile(join(cwd, 'untouched.txt'), 'unselected committed source\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'captured base'])
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  const contents = [
    { path: 'outputs/new.txt', bytes: Buffer.from('captured untracked output\n') },
    { path: 'selected.txt', bytes: Buffer.from('captured dirty source\n') }
  ]
  await mkdir(join(cwd, 'outputs'))
  await rm(join(cwd, 'deleted.txt'))
  const preparedInputPaths: string[] = []
  const files: ConsoleConversationFleetSourceFile[] = []
  for (const { path, bytes } of contents) {
    await writeFile(join(cwd, path), bytes)
    const downloaded = join(directory, `download-${preparedInputPaths.length}`)
    await writeFile(downloaded, bytes)
    preparedInputPaths.push(downloaded)
    files.push({
      kind: 'task_file' as const,
      task_id: 'btk_currentgit',
      file: {
        rel: `uploads/${preparedInputPaths.length}.txt`,
        name: basename(path),
        sha256: currentGitSha(bytes),
        size_bytes: bytes.length
      },
      target_path: path
    })
  }
  const deletedPaths = ['deleted.txt']
  const source = {
    schema_version: 1,
    kind: 'current_task_files',
    mode: 'review-source',
    stage_key: 'review-selected',
    root_task_id: 'btk_currentgit',
    producer: { provider: 'codex', model: 'gpt-6' },
    workspace: {
      kind: 'git',
      path: cwd,
      host: 'local',
      repo: 'gitlab.example/team/project',
      base_branch: 'main',
      base_sha: head
    },
    git: { head_sha: head, deleted_paths: deletedPaths },
    snapshot_digest: currentGitSha(
      canonicalDigestJson({
        head_sha: head,
        files: files.map((file) => ({
          target_path: file.target_path,
          sha256: file.file.sha256,
          size_bytes: file.file.size_bytes
        })),
        deleted_paths: deletedPaths
      })
    ),
    files
  }
  const input = {
    loop_stage: { key: 'review-selected', role: 'participant', round: 1 },
    current_source: source,
    source_files: structuredClone(files),
    source_deletions: [...deletedPaths],
    source_overlay: true
  }
  const job: ConsoleLocalJob = {
    id: 'job_currentgit1',
    taskId: 'btk_currentgit',
    workflowId: 'wf_currentgit',
    digest: 'b'.repeat(64),
    state: 'ready',
    placement: 'local',
    provider: 'codex',
    model: 'gpt-6',
    title: 'Review selected session files',
    repo: source.workspace.repo,
    baseSha: head,
    baseBranch: 'main',
    prompt: 'Review the selected current session files.',
    brief: 'Preserve the original session and report findings.',
    acceptance: 'Independent review of the selected bytes.',
    acceptanceCommands: [],
    inputs: [input, ...files],
    ownedPaths: ['workflow-loops/review-selected/**'],
    readOnly: true,
    action: 'review',
    artifactResult: { path: 'folder-review.json', format: 'json', maxBytes: 65536 }
  }
  const worktree = async (name = 'round1') => {
    const path = join(directory, name)
    const branch = `omni/${name}`
    await git(['worktree', 'add', '-b', branch, path, head])
    return { id: name, path, branch, startSha: head }
  }
  return { directory, cwd, git, job, input, preparedInputPaths, worktree }
}

export async function currentGitAcceptedCandidate(job: ConsoleLocalJob, cwd: string) {
  const producer = structuredClone(job)
  producer.action = 'repair'
  producer.readOnly = false
  producer.artifactResult = { path: 'folder-snapshot.json', format: 'json', maxBytes: 65536 }
  ;(producer.inputs[0] as { loop_stage: { role: string } }).loop_stage.role = 'repair'
  const artifact = await consoleFolderRoundArtifact(producer, 1, cwd, currentGitWorkerResult)
  const envelope = JSON.parse(Buffer.from(artifact.contentBase64, 'base64').toString('utf8')) as {
    files: (ConsoleFolderCandidate['manifest'][number] & { content_b64: string })[]
    changed_files: string[]
  }
  const manifest = envelope.files.map(({ path, mode, sha256, size_bytes }) => ({
    path,
    mode,
    sha256,
    size_bytes
  }))
  const candidate: ConsoleFolderCandidate = {
    schema_version: 1,
    producer_key: 'repair-selected',
    job_id: job.id,
    task_id: job.taskId,
    attempt: 1,
    receipt_event_id: 11,
    fingerprint: 'd'.repeat(64),
    result_event_id: 12,
    source_receipt_id: 'receipt-1',
    verification_report_id: 'verification-1',
    candidate_digest: 'e'.repeat(64),
    evidence_id: 'evidence-1',
    artifact: {
      file_id: 'tfl_gitsnapshot1',
      rel: 'uploads/folder-snapshot.json',
      sha256: artifact.sha256,
      size_bytes: Buffer.from(artifact.contentBase64, 'base64').length
    },
    snapshot_digest: currentGitSha(
      canonicalDigestJson(
        manifest.map((item) => ({
          target_path: item.path,
          sha256: item.sha256,
          size_bytes: item.size_bytes
        }))
      )
    ),
    manifest
  }
  return { artifact, candidate, envelope }
}
