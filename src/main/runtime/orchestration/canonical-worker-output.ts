import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import type {
  OrchestrationWorkerReadSource,
  OrchestrationWorkerReadTerminalResult
} from '../../../shared/orchestration-worker-output'
import { readTerminalTail } from '../../../shared/terminal-stream-read'
import { readTerminalHistoryExactExit } from '../../daemon/terminal-history-exact-exit'
import type { OrchestrationDb } from './db'
import { readCanonicalWorkerRecord } from './canonical-worker-record'
import { OrchestrationError } from './orchestration-error'
import {
  createWorkerOutputSourceIdentity,
  decodeWorkerOutputCursor,
  encodeWorkerOutputCursor
} from './worker-output-cursor'
import { redactWorkerTerminalLines } from './worker-transcript-payload'

/** The daemon's final stream keeps the live cursor's exact process and line coordinates. */
export function readCanonicalWorkerOutput(args: {
  db: OrchestrationDb
  dispatchId: string
  terminalHandle: string
  workerState: string
  source?: OrchestrationWorkerReadSource
  cursor?: string | number
  limit?: number
}): OrchestrationWorkerReadTerminalResult | null {
  const record = readCanonicalWorkerRecord(args.db, args.dispatchId)
  if (!record?.processIdentity || args.source === 'transcript') {
    return null
  }
  const cursor = decodeWorkerOutputCursor(args.cursor, args.dispatchId)
  if (cursor?.source === 'transcript') {
    if (args.source === 'terminal') {
      throw new OrchestrationError(
        'cursor_source_mismatch',
        'The cursor does not name terminal output.'
      )
    }
    return null
  }
  const dispatch = args.db.getDispatchContextById(args.dispatchId)
  const processIncarnation = dispatch?.process_incarnation
  const paneKey = dispatch?.assignee_pane_key
  if (!processIncarnation || !paneKey) {
    return null
  }
  const separator = processIncarnation.lastIndexOf(':')
  if (separator <= 0) {
    return null
  }
  const journal = readTerminalHistoryExactExit(
    join(getAppEnvironment().getPath('userData'), 'terminal-history'),
    processIncarnation.slice(0, separator),
    processIncarnation.slice(separator + 1)
  )
  if (journal.status !== 'readable' || !journal.observation.terminalStream) {
    return null
  }
  if (journal.observation.pid !== record.processIdentity.pid) {
    throw new OrchestrationError(
      'worker_identity_changed',
      'The output journal names another process.'
    )
  }
  const sourceIdentity = createWorkerOutputSourceIdentity(['terminal', processIncarnation, paneKey])
  if (cursor?.sourceIdentity && cursor.sourceIdentity !== sourceIdentity) {
    throw new OrchestrationError('source_changed', 'The terminal output source has changed.')
  }
  const stream = journal.observation.terminalStream
  if (cursor && cursor.position > stream.completedLineCount) {
    // An immutable final stream cannot grow back to satisfy a regressed cursor.
    throw new OrchestrationError(
      'source_changed',
      'The committed output is behind the requested cursor.'
    )
  }
  const terminalStatus = record.terminalProof?.process_exited === true ? 'exited' : 'unknown'
  const terminal = readTerminalTail({
    handle: args.terminalHandle,
    status: terminalStatus,
    previewLines: stream.previewLines,
    completedLines: stream.lines,
    partialLine: stream.partialLine,
    completedLineCount: stream.completedLineCount,
    bufferTruncated: stream.truncated,
    cursor: cursor?.position,
    limit: args.limit
  })
  const redacted = redactWorkerTerminalLines(terminal.tail)
  const position = Number(terminal.nextCursor)
  return {
    dispatchId: args.dispatchId,
    source: 'terminal',
    sourceIdentity,
    terminal: { ...terminal, source: 'stream', tail: redacted.lines },
    cursor: encodeWorkerOutputCursor(args.dispatchId, 'terminal', sourceIdentity, position),
    status: { worker: args.workerState, terminal: terminalStatus },
    fallbackReason: null,
    warnings: redacted.warnings,
    archived: true
  }
}
