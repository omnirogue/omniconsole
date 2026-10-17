import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { SessionFollowUpRule } from '../../shared/session-follow-up-rule'
import { captureSessionHandoff } from './session-handoff-capture'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('materializes all history pages and preserves each operation’s exact snapshot', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'handoff-history-')))
  roots.push(workspace)
  const transcriptPath = join(workspace, 'session.jsonl')
  const line = (message: string) =>
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message } })
  const history = Array.from({ length: 5201 }, (_, index) => line(`Message ${index}.`)).join('\n')
  await writeFile(transcriptPath, `${history}\n`)
  const rule: SessionFollowUpRule = {
    revision: 1,
    taskId: null,
    taskTitle: 'Complete conversation',
    sessionLabel: 'Complete conversation',
    recipients: [
      {
        employeeId: 'emp_recipient',
        name: 'Teammate',
        operationId: 'first_handoff',
        delivery: 'pending'
      }
    ],
    deliverables: { kind: 'files', paths: [] },
    destinationDirectory: workspace,
    includeSummary: false,
    transcriptSource: {
      kind: 'provider',
      hostId: 'local',
      agent: 'codex',
      sessionId: 'source-session',
      transcriptPath
    },
    note: 'Continue from this conversation.',
    savedAt: 1
  }
  const first = await captureSessionHandoff(rule, workspace, 'Current context')
  const pin = first.files![0]!
  expect(pin.generatedKind).toBe('transcript')
  expect(pin.sourcePath).toBeTruthy()
  const captured = await readFile(pin.sourcePath!)
  expect(captured.toString()).toContain('Message 0.')
  expect(captured.toString()).toContain('Message 5200.')
  expect(captured.length).toBeGreaterThan(80_000)
  expect(createHash('sha256').update(captured).digest('hex')).toBe(pin.sha256)
  expect(first.transcriptFile?.contentBase64).toBe(captured.toString('base64'))

  await writeFile(transcriptPath, `${history}\n${line('New work after the first share.')}\n`)
  const second = await captureSessionHandoff(
    {
      ...rule,
      recipients: [{ ...rule.recipients[0]!, operationId: 'second_handoff' }]
    },
    workspace,
    'New context'
  )
  expect(second.files![0]!.sourcePath).not.toBe(pin.sourcePath)
  expect(await readFile(pin.sourcePath!)).toEqual(captured)
  expect((await readFile(second.files![0]!.sourcePath!)).toString()).toContain(
    'New work after the first share.'
  )
})
