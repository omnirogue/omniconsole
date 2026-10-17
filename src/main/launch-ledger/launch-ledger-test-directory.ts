import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import {
  _resetLaunchLedgerForTests,
  flushLaunchLedger,
  LAUNCH_LEDGER_FILE,
  setLaunchLedgerDirectory,
  type LaunchLedgerRow
} from './launch-ledger'
import { _resetLatencyTelemetryEnabledReaderForTests } from '../observability/latency-probe-switch'

export function registerLaunchLedgerTestDirectory(): (
  includePrepared?: boolean
) => Promise<LaunchLedgerRow[]> {
  let directory: string
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'spawn-launch-red-'))
    await _resetLaunchLedgerForTests()
    await setLaunchLedgerDirectory(directory)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    await _resetLaunchLedgerForTests()
    _resetLatencyTelemetryEnabledReaderForTests()
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })
  return async (includePrepared = false) => {
    await flushLaunchLedger()
    const path = join(directory, LAUNCH_LEDGER_FILE)
    const rows: LaunchLedgerRow[] = existsSync(path)
      ? readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
    if (includePrepared) {
      return rows
    }
    const completed = new Set(
      rows
        .filter((row) => !['prepared', 'attachment-intent'].includes(row.process))
        .map((row) => row.launchId)
        .filter(Boolean)
    )
    return rows.filter(
      (row) =>
        !['prepared', 'attachment-intent'].includes(row.process) || !completed.has(row.launchId)
    )
  }
}
