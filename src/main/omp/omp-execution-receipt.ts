import type { ExactWorkerProviderSession } from '../../shared/orchestration-worker-output'
import { readConsoleJobProcessHandshake } from '../runtime/orchestration/console-job-process-handshake'
import { consoleJobProcessIdentity } from '../console-workflows/console-job-process-observation'
import { open } from 'node:fs/promises'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import type { ConsoleLocalExecutionRecord } from '../console-workflows/console-local-execution-state'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { ompExecutionReceipt, type OmpExecutionReceipt } from '../../shared/omp-execution-receipt'

export function parseOmpExecutionReceipt(
  text: string,
  input: {
    model: string
    openrouterCandidates?: string[]
    sessionId: string
    machine: string
    notBefore: number
  }
): OmpExecutionReceipt {
  const records = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const header = records[0]
  if (
    header?.type !== 'session' ||
    header.id !== input.sessionId ||
    !Number.isFinite(input.notBefore) ||
    Date.parse(header.timestamp) < input.notBefore ||
    !Number.isFinite(Date.parse(header.timestamp))
  ) {
    throw new Error('The OMP transcript does not attest this fresh worker invocation.')
  }
  const byId = new Map(
    records.filter((row) => typeof row.id === 'string').map((row) => [row.id, row])
  )
  const branch: typeof records = []
  const seen = new Set<string>()
  let row = records.at(-1)
  while (row && typeof row.id === 'string') {
    if (seen.has(row.id)) {
      throw new Error('The OMP transcript branch is cyclic.')
    }
    seen.add(row.id)
    branch.unshift(row)
    if (!row.parentId) {
      break
    }
    row = byId.get(row.parentId)
    if (!row) {
      throw new Error('The OMP transcript branch is incomplete.')
    }
  }
  if (
    branch.some(
      (entry) =>
        entry.type === 'message' &&
        entry.message?.role === 'assistant' &&
        (!Number.isFinite(Date.parse(entry.timestamp)) ||
          Date.parse(entry.timestamp) < input.notBefore)
    )
  ) {
    throw new Error('Prior-invocation OMP messages cannot attest this job.')
  }
  const attempts = branch
    .filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant')
    .map((entry) => ({
      provider: entry.message.provider,
      model: entry.message.model,
      stop_reason: entry.message.stopReason
    }))
  const allowed = input.openrouterCandidates ?? [input.model.slice(11)]
  const last = attempts.at(-1)
  if (
    !last ||
    !['stop', 'length'].includes(last.stop_reason) ||
    attempts.some(
      (entry, index) =>
        entry.provider !== 'openrouter' ||
        !allowed.includes(entry.model) ||
        (index === 0
          ? entry.model !== allowed[0]
          : allowed.indexOf(entry.model) < allowed.indexOf(attempts[index - 1].model))
    )
  ) {
    throw new Error('The OMP session lacks successful observed execution inside its saved route.')
  }
  return ompExecutionReceipt.parse({
    provider: 'omp',
    model: input.model,
    machine: input.machine,
    requested_provider: 'openrouter',
    requested_model: input.model.slice(11),
    ...(input.openrouterCandidates !== undefined
      ? { openrouter_candidates: input.openrouterCandidates }
      : {}),
    effective_provider: last.provider,
    effective_model: last.model,
    model_attempts: attempts,
    session_id: input.sessionId
  })
}

export async function readConsoleOmpExecution(
  runtime: OrcaRuntimeService,
  record: ConsoleLocalExecutionRecord,
  notBefore: number,
  captured?: ExactWorkerProviderSession | null
): Promise<OmpExecutionReceipt | undefined> {
  const job = record.attempt.job
  if (job.provider !== 'omp') {
    return undefined
  }
  const session = captured ?? captureConsoleOmpSession(runtime, record)
  if (!session || !record.binding.claim?.host) {
    throw new Error('The exact OMP worker session cannot be observed.')
  }
  const path = await resolveSessionFilePath('omp', session.providerSession.id, {
    transcriptPath: session.providerSession.transcriptPath
  })
  if (!path) {
    throw new Error('The OMP session transcript is unavailable.')
  }
  const file = await open(path, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > 32 * 1024 * 1024) {
      throw new Error('The OMP receipt transcript exceeds the bounded reader.')
    }
    const text = await file.readFile('utf8')
    const after = await file.stat()
    const current = captureConsoleOmpSession(runtime, record)
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      (current &&
        (current.processIncarnation !== session.processIncarnation ||
          JSON.stringify(current.providerSession) !== JSON.stringify(session.providerSession)))
    ) {
      throw new Error('The OMP session changed while reading its receipt.')
    }
    return parseOmpExecutionReceipt(text, {
      model: job.model,
      openrouterCandidates: job.openrouterCandidates,
      sessionId: session.providerSession.id,
      machine: record.binding.claim.host,
      notBefore
    })
  } finally {
    await file.close()
  }
}

export function captureConsoleOmpSession(
  runtime: OrcaRuntimeService,
  record: ConsoleLocalExecutionRecord
): ExactWorkerProviderSession | null {
  if (record.attempt.job.provider !== 'omp') {
    return null
  }
  const handshake = readConsoleJobProcessHandshake(
    runtime.getOrchestrationDb(),
    consoleJobProcessIdentity(record)
  )
  const handle = record.worker.agent_terminal_handle
  if (!handshake || !handle) {
    return null
  }
  const session = runtime.getExactWorkerProviderSession(handle, handshake.gate.processStartTimeMs)
  return session?.agent === 'omp' &&
    session.processIncarnation === `${handshake.gate.ptyId}:${handshake.gate.incarnationId}`
    ? session
    : null
}
