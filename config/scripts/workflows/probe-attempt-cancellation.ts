import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runProcess } from '../../../src/shared/child-process/run-process'
import {
  resolveCodexHomeProcessLockKey,
  withCodexHomeProcessLock
} from '../../../src/main/codex-cli/codex-home-process-lock'

async function main(): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-cancel-'))
  const schemaPath = join(cwd, 'schema.json')
  await writeFile(
    schemaPath,
    JSON.stringify({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false
    })
  )
  const codexArgs = [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    '--model',
    'gpt-5.6-sol',
    '-c',
    'project_doc_max_bytes=0',
    '--output-schema',
    schemaPath,
    '--json',
    '-'
  ]
  const controller = new AbortController()
  const queuedController = new AbortController()
  const key = resolveCodexHomeProcessLockKey()
  let sawThread = false
  let closed = false
  let queuedLaunches = 0
  let resolveStarted!: () => void
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  const running = withCodexHomeProcessLock(
    key,
    () =>
      runProcess({
        program: 'codex',
        args: codexArgs,
        cwd,
        input: 'Use the shell tool to run sleep 30. After it finishes return answer equal to done.',
        signal: controller.signal,
        timeoutMs: 60_000,
        terminationBarrier: true,
        onStdout: (chunk) => {
          if (chunk.toString().includes('thread.started')) {
            sawThread = true
            resolveStarted()
          }
        },
        onChildTerminated: () => {
          closed = true
        }
      }),
    controller.signal
  )
  const queued = withCodexHomeProcessLock(
    key,
    async () => {
      queuedLaunches++
      return 'unexpected launch'
    },
    queuedController.signal
  ).then(
    () => 'unexpected completion',
    () => 'cancelled while queued'
  )
  const oldGrok = JSON.parse(
    await readFile('docs/workflows/evidence/a01-grok-initial.json', 'utf8')
  )
  const siblingArgs = oldGrok.args as string[]
  siblingArgs[siblingArgs.indexOf('--session-id') + 1] = randomUUID()
  const sibling = runProcess({
    program: 'grok',
    args: siblingArgs,
    cwd,
    timeoutMs: 60_000,
    terminationBarrier: true
  })
  const outcome = running.then(() => 'ended-before-observation')
  const observation = await Promise.race([started.then(() => 'thread-started'), outcome])
  queuedController.abort(new Error('queued attempt stopped'))
  controller.abort(new Error('running attempt stopped'))
  const [runningResult, queuedResult, siblingResult] = await Promise.all([running, queued, sibling])
  await withCodexHomeProcessLock(key, async () => {})
  const evidence = {
    testId: 'A04-real-attempt-cancellation',
    observation,
    sawThread,
    closed,
    queuedLaunches,
    queuedResult,
    runningResult,
    siblingResult,
    limitation: 'Root/stdio closure is observed; independent process-tree attestation remains A05.'
  }
  await writeFile(
    'docs/workflows/evidence/a04-real-attempt-cancellation.json',
    `${JSON.stringify(evidence, null, 2)}\n`
  )
  console.log(JSON.stringify(evidence, null, 2))
  process.exitCode = sawThread && closed && queuedLaunches === 0 && siblingResult.code === 0 ? 0 : 1
}
void main()
