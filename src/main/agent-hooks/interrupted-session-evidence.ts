import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { writeFileDurableSync } from '../durable-file-write'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'

function evidenceFile(paneKey: string): string {
  return join(
    getCanonicalUserDataPath(),
    'agent-hooks',
    'interruptions',
    `${createHash('sha256').update(paneKey).digest('hex')}.json`
  )
}

export function rememberInterruptedStatus(status: AgentStatusIpcPayload): void {
  const directory = join(getCanonicalUserDataPath(), 'agent-hooks', 'interruptions')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = evidenceFile(status.paneKey)
  writeFileDurableSync(`${file}.tmp`, file, JSON.stringify(status))
}

export function forgetInterruptedStatus(paneKey: string): void {
  rmSync(evidenceFile(paneKey), { force: true })
}

export function readInterruptedStatus(paneKey: string): AgentStatusIpcPayload | undefined {
  try {
    const row: AgentStatusIpcPayload = JSON.parse(readFileSync(evidenceFile(paneKey), 'utf8'))
    if (
      row.paneKey === paneKey &&
      row.state === 'working' &&
      row.connectionId === null &&
      typeof row.stateStartedAt === 'number' &&
      Number.isFinite(row.stateStartedAt) &&
      row.stateStartedAt > 0
    ) {
      return row
    }
  } catch {
    // Missing or unreadable evidence never authorizes continuation.
  }
  return undefined
}
