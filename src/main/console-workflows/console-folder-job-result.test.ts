import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  ConsoleLocalJob,
  ConsoleLocalResult,
  ConsoleLocalTerminalProof
} from './console-local-execution-contract'
import { consoleJobArtifact, recordConsoleFolderJobResult } from './console-folder-job-result'
import { consoleJobOutputDigest } from './console-job-digests'

const job: ConsoleLocalJob = {
  id: 'job_folder',
  taskId: 'btk_folder',
  workflowId: 'wf_folder',
  digest: 'a'.repeat(64),
  state: 'running',
  placement: 'local',
  provider: 'codex',
  model: 'gpt-5.5',
  title: 'Write a folder report',
  workspace: { kind: 'folder', path: '/workspace/report' },
  repo: null,
  baseSha: null,
  baseBranch: null,
  prompt: 'Write the report.',
  brief: 'Write the report.',
  acceptance: 'Report with physical process exit evidence.',
  acceptanceCommands: [],
  inputs: [],
  ownedPaths: null,
  readOnly: false
}

const proof: ConsoleLocalTerminalProof = {
  kind: 'exited',
  process_identity: {
    pid: 731,
    started_at: '2026-09-12T12:00:00.000Z',
    runner_instance: 'runner_folder'
  },
  process_exited: true,
  process_exit_code: 0,
  exit_cause: { kind: 'exited', exit_code: 0 },
  observed_at: '2026-09-12T12:01:00.000Z'
}

function record(
  terminalProof: ConsoleLocalTerminalProof = proof,
  workerSucceeded = true
): ConsoleLocalResult {
  return recordConsoleFolderJobResult({
    job,
    workerSucceeded,
    proof: terminalProof,
    findings: { worker_report: 'Report complete: café 🚀\nPhysical exit observed.' },
    sanitize: (value) => value
  })
}

describe('folder result artifact bytes', () => {
  it('serializes equivalent result and nested proof construction orders identically', () => {
    const original = record()
    const reordered = Object.fromEntries(
      Object.entries(original).toReversed()
    ) as ConsoleLocalResult
    reordered.terminal_proof = {
      observed_at: proof.observed_at,
      exit_cause: { exit_code: 0, kind: 'exited' },
      process_exit_code: 0,
      process_exited: true,
      process_identity: {
        runner_instance: proof.process_identity.runner_instance,
        started_at: proof.process_identity.started_at,
        pid: proof.process_identity.pid
      },
      kind: 'exited'
    }

    expect(consoleJobArtifact(reordered)).toEqual(consoleJobArtifact(original))
  })

  it('hashes the exact decoded evidence bytes independently of publication metadata', () => {
    const result = record()
    const artifact = consoleJobArtifact(result)
    const bytes = Buffer.from(artifact.contentBase64, 'base64')
    expect(JSON.parse(bytes.toString('utf8'))).toEqual({
      status: 'done',
      exit_code: 0,
      result_exit_code: 0,
      worker_report: result.worker_report,
      terminal_proof: proof
    })
    expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))

    const uploaded = {
      ...result,
      file_id: 'tfl_folderresult',
      artifact_sha256: artifact.sha256,
      output_tail: 'A different display tail.'
    }
    uploaded.output_digest = consoleJobOutputDigest(uploaded)
    expect(uploaded.output_digest).not.toBe(result.output_digest)
    expect(consoleJobArtifact(uploaded)).toEqual(artifact)
  })

  it('accepts exactly 65536 decoded bytes and rejects one more UTF-8 byte', () => {
    const emptyReport = { ...record(), worker_report: '' }
    const overhead = Buffer.from(consoleJobArtifact(emptyReport).contentBase64, 'base64').length
    const available = 65_536 - overhead
    const atLimit = {
      ...emptyReport,
      worker_report: 'é'.repeat(Math.floor(available / 2)) + 'x'.repeat(available % 2)
    }
    const artifact = consoleJobArtifact(atLimit)
    expect(Buffer.from(artifact.contentBase64, 'base64')).toHaveLength(65_536)
    expect(() =>
      consoleJobArtifact({ ...atLimit, worker_report: `${atLimit.worker_report}x` })
    ).toThrow(/bounded evidence limit/)
  })

  it.each([true, false])(
    'preserves native process exit 37 when workerSucceeded is %s',
    (workerSucceeded) => {
      const result = record(
        { ...proof, process_exit_code: 37, exit_cause: { kind: 'exited', exit_code: 37 } },
        workerSucceeded
      )
      expect(result).toMatchObject({ status: 'failed', exit_code: 37, result_exit_code: 37 })
      const artifact = consoleJobArtifact(result)
      expect(
        JSON.parse(Buffer.from(artifact.contentBase64, 'base64').toString('utf8'))
      ).toMatchObject({
        status: 'failed',
        exit_code: 37,
        result_exit_code: 37,
        terminal_proof: { process_exit_code: 37, exit_cause: { kind: 'exited', exit_code: 37 } }
      })
    }
  )

  it('omits an unavailable result exit code when the process ended by signal', () => {
    const result = record({
      ...proof,
      process_exit_code: null,
      exit_cause: { kind: 'signaled', signal: 15 }
    })
    expect(result).toMatchObject({ status: 'failed', exit_code: null })
    expect(result).not.toHaveProperty('result_exit_code')
    const artifact = consoleJobArtifact(result)
    const decoded = JSON.parse(Buffer.from(artifact.contentBase64, 'base64').toString('utf8'))
    expect(decoded).not.toHaveProperty('result_exit_code')
    expect(decoded.terminal_proof).toMatchObject({
      process_exit_code: null,
      exit_cause: { kind: 'signaled', signal: 15 }
    })
  })
})
