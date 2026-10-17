import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkflowLocalProcessLaunch } from './workflow-local-process-launch'
import { readWorkflowProcessReceipt } from './workflow-process-receipt'
import { workflowEvidenceDigest } from './workflow-checkpoint-store'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-receipt-'))
  directories.push(directory)
  const ledger = join(directory, 'ledger')
  const args = [
    '-e',
    `require('node:fs').appendFileSync(${JSON.stringify(ledger)}, 'spawn\\n'); process.stdin.pipe(process.stdout)`
  ]
  const expected = {
    directory,
    hostId: 'fixture-host',
    ownerIncarnation: 'fixture-owner',
    executionId: 'execution',
    fence: 1,
    attemptId: 'attempt',
    callId: 'answers/a',
    ordinal: 1,
    commandDigest: workflowEvidenceDigest(JSON.stringify([process.execPath, args])),
    inputDigest: workflowEvidenceDigest('answer'),
    maxOutputBytes: 1024
  }
  const launch = createWorkflowLocalProcessLaunch({
    ...expected,
    timeoutMs: 3000,
    command: () => ({ program: process.execPath, args, input: 'answer' })
  })
  const original = await launch({
    attemptId: 'attempt',
    ordinal: 1,
    problems: null,
    signal: new AbortController().signal,
    recordPreparation: () => {},
    recordLaunch: () => {},
    recordNoLaunch: () => {},
    call: {
      id: 'answers/a',
      seatId: 'a',
      prompt: 'answer',
      dependencies: [],
      schema: {},
      validateSemantics: () => null
    }
  })
  const launchPath = join(directory, 'attempt', 'launch.json')
  const terminalPath = join(directory, 'attempt', 'terminal.json')
  return { expected, original, ledger, launchPath, terminalPath }
}

describe.skipIf(process.platform === 'win32')('saved process receipt acceptance', () => {
  it('reconstructs the original result repeatedly without another process launch', async () => {
    const f = await fixture()
    for (let index = 0; index < 5; index++) {
      expect(readWorkflowProcessReceipt(f.expected)).toEqual(f.original)
    }
    expect(readWorkflowProcessReceipt(f.expected).exitedAt).toBe(
      Date.parse(JSON.parse(readFileSync(f.terminalPath, 'utf8')).exitedAt)
    )
    expect(readFileSync(f.ledger, 'utf8')).toBe('spawn\n')
  })
  it.each([
    'hostId',
    'ownerIncarnation',
    'executionId',
    'fence',
    'callId',
    'ordinal',
    'commandDigest',
    'inputDigest'
  ] as const)('refuses a receipt belonging to another %s', async (field) => {
    const f = await fixture()
    const value = typeof f.expected[field] === 'number' ? 2 : 'a'.repeat(64)
    expect(() => readWorkflowProcessReceipt({ ...f.expected, [field]: value })).toThrow()
  })
  it.each(['launch.json', 'terminal.json'])('does not infer exit from missing %s', async (name) => {
    const f = await fixture()
    rmSync(join(f.expected.directory, 'attempt', name))
    expect(() => readWorkflowProcessReceipt(f.expected)).toThrow()
    expect(readFileSync(f.ledger, 'utf8')).toBe('spawn\n')
  })
  it('rejects edited native output and edited launch evidence', async () => {
    const f = await fixture()
    const terminal = JSON.parse(readFileSync(f.terminalPath, 'utf8'))
    terminal.result.stdout = 'changed'
    writeFileSync(f.terminalPath, JSON.stringify(terminal))
    expect(() => readWorkflowProcessReceipt(f.expected)).toThrow('unverifiable')
    terminal.resultDigest = workflowEvidenceDigest(JSON.stringify(terminal.result))
    writeFileSync(f.terminalPath, JSON.stringify(terminal))
    appendFileSync(f.launchPath, ' ')
    expect(() => readWorkflowProcessReceipt(f.expected)).toThrow('unverifiable')
  })
  it('checks the native result shape even when its digest matches', async () => {
    const f = await fixture()
    const terminal = JSON.parse(readFileSync(f.terminalPath, 'utf8'))
    terminal.result.timedOut = 'false'
    terminal.resultDigest = workflowEvidenceDigest(JSON.stringify(terminal.result))
    writeFileSync(f.terminalPath, JSON.stringify(terminal))
    expect(() => readWorkflowProcessReceipt(f.expected)).toThrow('unverifiable')
  })
  it('keeps a recorded stall and refuses a malformed one', async () => {
    const f = await fixture()
    const terminal = JSON.parse(readFileSync(f.terminalPath, 'utf8'))
    const write = (stalledAfterMs: unknown) => {
      terminal.result.stalledAfterMs = stalledAfterMs
      terminal.resultDigest = workflowEvidenceDigest(JSON.stringify(terminal.result))
      writeFileSync(f.terminalPath, JSON.stringify(terminal))
    }
    write(600_000)
    expect(readWorkflowProcessReceipt(f.expected).result).toMatchObject({ stalledAfterMs: 600_000 })
    for (const malformed of [0, -1, 1.5, '600000']) {
      write(malformed)
      expect(() => readWorkflowProcessReceipt(f.expected)).toThrow('unverifiable')
    }
  })
  it('refuses oversized files and output instead of allocating unbounded capture', async () => {
    const f = await fixture()
    expect(() => readWorkflowProcessReceipt({ ...f.expected, maxOutputBytes: 2 })).toThrow()
    writeFileSync(f.terminalPath, ' '.repeat(100_000))
    expect(() => readWorkflowProcessReceipt(f.expected)).toThrow('unverifiable')
  })
  it.each(['file', 'directory'])('rejects receipt %s symlinks', async (kind) => {
    const f = await fixture()
    const path = kind === 'file' ? f.terminalPath : join(f.expected.directory, 'attempt')
    renameSync(path, `${path}-moved`)
    symlinkSync(`${path}-moved`, path)
    expect(() => readWorkflowProcessReceipt(f.expected)).toThrow()
  })
})
