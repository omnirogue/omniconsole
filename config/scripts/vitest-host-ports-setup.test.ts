import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { removeTestProfileDirectory } from './vitest-host-ports-setup'
import {
  _resetLaunchLedgerForTests,
  flushLaunchLedger,
  LAUNCH_LEDGER_FILE,
  recordLaunch,
  setLaunchLedgerDirectory
} from '../../src/main/launch-ledger/launch-ledger'
import { getProfileUserDataPath } from '../../src/main/omni-profiles/profile-storage-paths'

it('drains an immediate launch before profile teardown and resets the next write destination', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-vitest-ledger-teardown-'))
  const launch = {
    pipeline: 'runtime-controller' as const,
    ptyId: 'pty-1',
    cause: { trigger: 'terminal-create' as const },
    hasStartupCommand: false,
    process: 'created' as const
  }
  try {
    await setLaunchLedgerDirectory(directory)
    recordLaunch(launch)
    await removeTestProfileDirectory(directory)
    await flushLaunchLedger()
    expect(existsSync(directory)).toBe(false)

    recordLaunch({ ...launch, ptyId: 'pty-2' })
    await flushLaunchLedger()
    const rows = readFileSync(join(getProfileUserDataPath(), LAUNCH_LEDGER_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(rows).toEqual([
      {
        v: 1,
        ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        pipeline: 'runtime-controller',
        ptyId: 'pty-2',
        cause: 'terminal-create',
        hasStartupCommand: false,
        process: 'created'
      }
    ])
    expect(existsSync(directory)).toBe(false)
  } finally {
    await _resetLaunchLedgerForTests()
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
  // Leave one append pending for the real suite-level teardown as well.
  recordLaunch({ ...launch, ptyId: 'pty-3' })
})
