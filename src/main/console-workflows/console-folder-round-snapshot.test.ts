import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { consoleJobClaimFixture } from '../runtime/orchestration/console-job-test-fixture'
import type {
  ConsoleLocalActivation,
  ConsoleLocalJob,
  ConsoleLocalResult
} from './console-local-execution-contract'
import {
  consoleFolderRoundArtifact,
  hydrateConsoleFolderCandidate
} from './console-folder-round-snapshot'
import { canonicalDigestJson } from './console-job-digests'
import {
  ConsoleArtifactEvidenceError,
  ConsoleArtifactEvidenceLimitError
} from './console-folder-job-result'

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const roots: string[] = []

function job(path: 'folder-snapshot.json' | 'folder-review.json'): ConsoleLocalJob {
  const original = Buffer.from('original\n')
  return {
    artifactResult: { path, format: 'json', maxBytes: 65536 },
    id: 'job_local1234',
    taskId: 'btk_localfixture',
    workflowId: 'wf_fixture',
    digest: 'b'.repeat(64),
    state: 'running',
    placement: 'local',
    provider: 'codex',
    model: 'gpt-6',
    title: 'Folder round',
    workspace: { kind: 'folder', path: '/selected' },
    repo: null,
    baseSha: null,
    baseBranch: null,
    prompt: 'prompt',
    brief: 'brief',
    acceptance: 'accept',
    acceptanceCommands: [],
    inputs: [
      {
        loop_stage: { key: 'producer', role: 'producer', round: 1 },
        current_source: { snapshot_digest: sha(original) },
        source_files: [
          { kind: 'task_file', target_path: 'selected.txt', file: { sha256: sha(original) } }
        ]
      }
    ],
    ownedPaths: ['selected.txt'],
    readOnly: false,
    action: 'execute'
  }
}

const result: ConsoleLocalResult = {
  status: 'done',
  exit_code: 0,
  worker_report: 'actual provider response',
  output_tail: 'done',
  candidate_sha: null,
  branch: null,
  pr_url: null,
  pr_number: null,
  changed_files: [],
  owned_paths_violations: [],
  terminal_proof: { kind: 'not_started', exit_code: null },
  output_digest: 'c'.repeat(64)
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'folder-round-'))
  roots.push(path)
  return path
}

describe('local folder round snapshot boundary', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('hydrates exact revised bytes and captures the next repair generation', async () => {
    const producerRoot = await directory()
    await writeFile(join(producerRoot, 'selected.txt'), 'revised once\n')
    await writeFile(join(producerRoot, 'zz-manual.txt'), 'accepted secondary\n')
    const producer = job('folder-snapshot.json')
    const extraSource = {
      kind: 'task_file',
      target_path: 'zz-manual.txt',
      file: { sha256: sha('original\n') }
    }
    ;(producer.inputs[0] as { source_files: unknown[] }).source_files.push(extraSource)
    const artifact = await consoleFolderRoundArtifact(producer, 2, producerRoot, result)
    const envelope = JSON.parse(Buffer.from(artifact.contentBase64, 'base64').toString('utf8'))
    const manifest = envelope.files.map((item: Record<string, unknown>) => ({
      path: item.path,
      mode: item.mode,
      sha256: item.sha256,
      size_bytes: item.size_bytes
    }))
    const candidate = {
      schema_version: 1,
      producer_key: 'producer',
      job_id: producer.id,
      task_id: producer.taskId,
      attempt: 2,
      receipt_event_id: 11,
      fingerprint: 'd'.repeat(64),
      result_event_id: 12,
      source_receipt_id: 'receipt-1',
      verification_report_id: 'verification-1',
      candidate_digest: 'e'.repeat(64),
      evidence_id: 'evidence-1',
      artifact: {
        file_id: 'tfl_snapshot1',
        rel: 'uploads/snapshot.json',
        sha256: artifact.sha256,
        size_bytes: Buffer.from(artifact.contentBase64, 'base64').length
      },
      snapshot_digest: sha(
        canonicalDigestJson(
          manifest.map((item: Record<string, unknown>) => ({
            target_path: item.path,
            sha256: item.sha256,
            size_bytes: item.size_bytes
          }))
        )
      ),
      manifest
    }
    const consumer = job('folder-snapshot.json')
    ;(consumer.inputs[0] as { source_files: unknown[] }).source_files.push(extraSource)
    ;(consumer.inputs[0] as Record<string, unknown>).folder_candidate = candidate
    const consumerRoot = await directory()
    await writeFile(join(consumerRoot, 'selected.txt'), 'original\n')
    await writeFile(join(consumerRoot, 'zz-manual.txt'), 'User edits while queued\n')
    const activation = {
      job: consumer,
      principal: 'a'.repeat(64),
      binding: { ...consoleJobClaimFixture, jobId: consumer.id }
    } satisfies ConsoleLocalActivation

    await expect(
      hydrateConsoleFolderCandidate({
        activation,
        workspacePath: consumerRoot,
        candidate: { ...candidate, result_event_id: 13 },
        contentBase64: artifact.contentBase64
      })
    ).rejects.toThrow('differs from the activated handoff')
    expect(await readFile(join(consumerRoot, 'selected.txt'), 'utf8')).toBe('original\n')

    await expect(
      hydrateConsoleFolderCandidate({
        activation,
        workspacePath: consumerRoot,
        candidate,
        contentBase64: artifact.contentBase64
      })
    ).rejects.toThrow('changed after its authorized snapshot')
    expect(await readFile(join(consumerRoot, 'selected.txt'), 'utf8')).toBe('original\n')
    expect(await readFile(join(consumerRoot, 'zz-manual.txt'), 'utf8')).toBe(
      'User edits while queued\n'
    )
    await writeFile(join(consumerRoot, 'zz-manual.txt'), 'original\n')
    await hydrateConsoleFolderCandidate({
      activation,
      workspacePath: consumerRoot,
      candidate,
      contentBase64: artifact.contentBase64
    })
    expect(await readFile(join(consumerRoot, 'selected.txt'), 'utf8')).toBe('revised once\n')

    await writeFile(join(consumerRoot, 'selected.txt'), 'revised twice\n')
    const repaired = await consoleFolderRoundArtifact(consumer, 3, consumerRoot, result)
    expect(
      JSON.parse(Buffer.from(repaired.contentBase64, 'base64').toString('utf8'))
    ).toMatchObject({ attempt: 3, changed_files: ['selected.txt'] })
  })

  it('rejects stale metadata and malformed candidate bytes before workspace replacement', async () => {
    const root = await directory()
    await writeFile(join(root, 'selected.txt'), 'preserved\n')
    const consumer = job('folder-snapshot.json')
    const candidate = { folder_candidate: { schema_version: 1 } }
    ;(consumer.inputs[0] as Record<string, unknown>).folder_candidate = candidate.folder_candidate
    const activation = {
      job: consumer,
      principal: 'a'.repeat(64),
      binding: { ...consoleJobClaimFixture, jobId: consumer.id }
    } satisfies ConsoleLocalActivation
    await expect(
      hydrateConsoleFolderCandidate({
        activation,
        workspacePath: root,
        candidate: candidate.folder_candidate,
        contentBase64: 'not canonical base64'
      })
    ).rejects.toThrow()
    expect(await readFile(join(root, 'selected.txt'), 'utf8')).toBe('preserved\n')
  })

  it('fails instead of truncating a selected snapshot over 64 KiB', async () => {
    const root = await directory()
    await writeFile(join(root, 'selected.txt'), Buffer.alloc(50_000, 1))
    await expect(
      consoleFolderRoundArtifact(job('folder-snapshot.json'), 1, root, result)
    ).rejects.toBeInstanceOf(ConsoleArtifactEvidenceLimitError)
  })

  it('reports an oversized review report as bounded evidence, not a host fault', async () => {
    const root = await directory()
    await expect(
      consoleFolderRoundArtifact(job('folder-review.json'), 1, root, {
        ...result,
        worker_report: '界'.repeat(32_000)
      })
    ).rejects.toBeInstanceOf(ConsoleArtifactEvidenceLimitError)
  })

  it.skipIf(process.platform === 'win32')(
    'reports a symlink or directory left at a selected path as worker output evidence',
    async () => {
      const root = await directory()
      await symlink(join(root, 'elsewhere'), join(root, 'selected.txt'))
      await expect(
        consoleFolderRoundArtifact(job('folder-snapshot.json'), 1, root, result)
      ).rejects.toBeInstanceOf(ConsoleArtifactEvidenceError)
      await rm(join(root, 'selected.txt'))
      await mkdir(join(root, 'selected.txt'))
      await expect(
        consoleFolderRoundArtifact(job('folder-snapshot.json'), 1, root, result)
      ).rejects.toBeInstanceOf(ConsoleArtifactEvidenceError)
    }
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a permission-denied selected path as recorded evidence, not a raw throw',
    async () => {
      const root = await directory()
      await writeFile(join(root, 'selected.txt'), 'secret\n')
      await chmod(join(root, 'selected.txt'), 0o000)
      try {
        await expect(
          consoleFolderRoundArtifact(job('folder-snapshot.json'), 1, root, result)
        ).rejects.toBeInstanceOf(ConsoleArtifactEvidenceError)
        await expect(
          consoleFolderRoundArtifact(job('folder-snapshot.json'), 1, root, result)
        ).rejects.toThrow('Permission denied')
      } finally {
        await chmod(join(root, 'selected.txt'), 0o644)
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a selected nested path through a symlinked parent',
    async () => {
      const root = await directory()
      const outside = await directory()
      await writeFile(join(outside, 'selected.txt'), 'outside\n')
      await symlink(outside, join(root, 'nested'))
      const selected = job('folder-snapshot.json')
      ;(
        selected.inputs[0] as { source_files: { target_path: string }[] }
      ).source_files[0]!.target_path = 'nested/selected.txt'
      await expect(consoleFolderRoundArtifact(selected, 1, root, result)).rejects.toThrow(
        'real directory'
      )
      await expect(consoleFolderRoundArtifact(selected, 1, root, result)).rejects.toBeInstanceOf(
        ConsoleArtifactEvidenceError
      )
    }
  )
})
