import { createHash } from 'node:crypto'
import type { ConsoleJobBinding } from '../../shared/console-workflow-types'
import type { ConsoleLocalJob, ConsoleLocalResult } from './console-local-execution-contract'

function compareCodePoints(left: string, right: string): number {
  const a = [...left]
  const b = [...right]
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const delta = a[index].codePointAt(0)! - b[index].codePointAt(0)!
    if (delta) {
      return delta
    }
  }
  return a.length - b.length
}

export function consoleJobOutputDigest(result: Omit<ConsoleLocalResult, 'output_digest'>): string {
  const proof = result.terminal_proof
  const value = {
    artifact_sha256: result.artifact_sha256 ?? null,
    ...(result.execution ? { execution: result.execution } : {}),
    branch: result.branch,
    candidate_sha: result.candidate_sha,
    changed_files: [...new Set(result.changed_files)]
      .filter(Boolean)
      .sort(compareCodePoints)
      .slice(0, 500),
    owned_paths_violations: [...new Set(result.owned_paths_violations)]
      .filter(Boolean)
      .sort(compareCodePoints)
      .slice(0, 500),
    pr_number: result.pr_number,
    pr_url: result.pr_url,
    status: result.status,
    terminal_proof:
      'process_exit_code' in proof
        ? {
            exit_cause: proof.exit_cause,
            kind: proof.kind,
            process_exit_code: proof.process_exit_code
          }
        : { exit_code: proof.exit_code, kind: proof.kind },
    ...(result.result_exit_code === undefined ? {} : { result_exit_code: result.result_exit_code })
  }
  return createHash('sha256').update(canonicalDigestJson(value)).digest('hex')
}

export function canonicalDigestJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalDigestJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => compareCodePoints(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalDigestJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function consoleJobInputDigest(
  binding: ConsoleJobBinding,
  job: ConsoleLocalJob,
  baseSha: string | null
): string {
  const value = {
    task_id: binding.taskId,
    contract_id: binding.contractId ?? null,
    contract_digest: binding.contractDigest ?? null,
    contract_generation: binding.contractGeneration ?? null,
    base_sha: baseSha,
    brief: job.brief,
    acceptance: job.acceptance,
    owned_paths: job.ownedPaths?.length ? job.ownedPaths : null,
    checkouts: [],
    execution: {
      provider: job.provider,
      model: job.model,
      effort: job.effort ?? null,
      ...(job.openrouterCandidates !== undefined
        ? { openrouter_candidates: job.openrouterCandidates }
        : {})
    },
    acceptance_commands: job.acceptanceCommands.map(({ program, args, timeoutMs }) => ({
      program,
      args,
      timeout_ms: timeoutMs
    }))
  }
  return createHash('sha256').update(canonicalDigestJson(value)).digest('hex')
}
