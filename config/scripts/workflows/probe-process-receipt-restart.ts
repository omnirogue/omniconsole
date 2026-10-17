import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowLocalProcessLaunch } from '../../../src/main/runtime/workflow-script/workflow-local-process-launch'
import {
  readWorkflowProcessReceipt,
  type WorkflowProcessReceiptIdentity
} from '../../../src/main/runtime/workflow-script/workflow-process-receipt'
import { workflowEvidenceDigest } from '../../../src/main/runtime/workflow-script/workflow-checkpoint-store'

async function main() {
  const [mode, requestedDirectory] = process.argv.slice(2)
  if (!['launch', 'read'].includes(mode) || (mode === 'read' && !requestedDirectory)) {
    throw new Error('Expected launch or read <fixture directory>')
  }
  const directory = requestedDirectory ?? mkdtempSync(join(tmpdir(), 'workflow-receipt-restart-'))
  const manifest = join(directory, 'expected-identity.json')
  const ledger = join(directory, 'spawn-ledger')
  if (mode === 'launch') {
    const args = [
      '-e',
      `require('node:fs').appendFileSync(${JSON.stringify(ledger)}, 'spawn\\n'); process.stdout.write(JSON.stringify({answer:'restart-proof'}))`
    ]
    const expected: WorkflowProcessReceiptIdentity = {
      directory,
      executionId: randomUUID(),
      attemptId: randomUUID(),
      fence: 1,
      hostId: 'diagnostic-fixture-host',
      ownerIncarnation: randomUUID(),
      callId: 'answer/fixture',
      ordinal: 1,
      maxOutputBytes: 1024,
      commandDigest: workflowEvidenceDigest(JSON.stringify([process.execPath, args])),
      inputDigest: workflowEvidenceDigest('')
    }
    // Independent expected identity exists before the process creates its receipts.
    writeFileSync(manifest, JSON.stringify(expected), { flag: 'wx', mode: 0o600 })
    const launch = createWorkflowLocalProcessLaunch({
      ...expected,
      timeoutMs: 3000,
      command: () => ({ program: process.execPath, args })
    })
    const result = await launch({
      attemptId: expected.attemptId,
      ordinal: 1,
      problems: null,
      signal: new AbortController().signal,
      recordPreparation: () => {},
      recordLaunch: () => {},
      call: {
        id: expected.callId,
        seatId: 'fixture',
        prompt: '',
        dependencies: [],
        schema: {},
        validateSemantics: () => null
      }
    })
    writeFileSync(
      join(directory, 'launch-report.json'),
      JSON.stringify({ pid: process.pid, result })
    )
  } else {
    const expected = JSON.parse(readFileSync(manifest, 'utf8')) as WorkflowProcessReceiptIdentity
    const before = readFileSync(ledger, 'utf8')
    const result = readWorkflowProcessReceipt(expected)
    const original = JSON.parse(readFileSync(join(directory, 'launch-report.json'), 'utf8'))
    if (
      original.pid === process.pid ||
      JSON.stringify(original.result) !== JSON.stringify(result) ||
      readFileSync(ledger, 'utf8') !== before ||
      before !== 'spawn\n'
    ) {
      throw new Error('Fresh-process receipt reconstruction failed')
    }
    writeFileSync(
      join(directory, 'read-report.json'),
      JSON.stringify({ pid: process.pid, originalPid: original.pid, result, spawnCount: 1 })
    )
  }
  console.log(JSON.stringify({ mode, directory, pid: process.pid }))
}
void main()
