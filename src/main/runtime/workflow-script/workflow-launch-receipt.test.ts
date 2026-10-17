import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkflowLaunchedAt } from './workflow-launch-receipt'
import type { WorkflowProcessReceiptIdentity } from './workflow-process-receipt-identity'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function receiptDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'omni-launch-receipt-'))
  directories.push(path)
  await mkdir(join(path, 'attempt-1'))
  return path
}

function identity(directory: string): WorkflowProcessReceiptIdentity {
  return {
    directory,
    executionId: 'execution-1',
    hostId: 'host-1',
    ownerIncarnation: 'incarnation-1',
    fence: 1,
    attemptId: 'attempt-1',
    callId: 'answer/seat-1',
    ordinal: 1,
    commandDigest: 'a'.repeat(64),
    inputDigest: 'b'.repeat(64),
    maxOutputBytes: 1024
  }
}

function launch(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    hostId: 'host-1',
    ownerIncarnation: 'incarnation-1',
    executionId: 'execution-1',
    fence: 1,
    attemptId: 'attempt-1',
    callId: 'answer/seat-1',
    ordinal: 1,
    ownerPid: 10,
    pid: 20,
    processGroupId: 20,
    platform: process.platform,
    launchedAt: '2026-09-21T10:00:00.000Z',
    commandDigest: 'a'.repeat(64),
    inputDigest: 'b'.repeat(64),
    ...overrides
  })
}

describe('running attempt launch time', () => {
  it('reads the launch time of the attempt it was asked about', async () => {
    const directory = await receiptDirectory()
    await writeFile(join(directory, 'attempt-1', 'launch.json'), launch())
    expect(readWorkflowLaunchedAt(identity(directory))).toBe(Date.parse('2026-09-21T10:00:00.000Z'))
  })

  it('has no time for another attempt, a missing receipt or a linked receipt', async () => {
    const directory = await receiptDirectory()
    await writeFile(join(directory, 'attempt-1', 'launch.json'), launch({ callId: 'rank/seat-1' }))
    expect(readWorkflowLaunchedAt(identity(directory))).toBeUndefined()
    expect(readWorkflowLaunchedAt(identity(await receiptDirectory()))).toBeUndefined()
    const linked = await receiptDirectory()
    await writeFile(join(linked, 'elsewhere.json'), launch())
    await symlink(join(linked, 'elsewhere.json'), join(linked, 'attempt-1', 'launch.json'))
    expect(readWorkflowLaunchedAt(identity(linked))).toBeUndefined()
    expect(
      readWorkflowLaunchedAt({ ...identity(directory), directory: 'relative' })
    ).toBeUndefined()
  })
})
