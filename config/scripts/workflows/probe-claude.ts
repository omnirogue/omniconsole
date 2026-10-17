import { mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runProcess } from '../../../src/shared/child-process/run-process'

async function main(): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-gate-a-'))
  const attemptId = randomUUID()
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false
  }
  const args = [
    '-p',
    '--model',
    'sonnet',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--session-id',
    attemptId,
    '--system-prompt',
    'Return the requested structured object. No tools are available.'
  ]
  const startedAt = new Date().toISOString()
  let stdoutBytes = 0
  let closed = false
  const result = await runProcess({
    program: 'claude',
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(homedir(), '.claude') },
    args,
    cwd,
    input: 'Set answer to council-native-schema-probe.',
    timeoutMs: 90_000,
    maxOutputBytes: 256 * 1024,
    terminationBarrier: true,
    onStdout: (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk)
    },
    onChildTerminated: () => {
      closed = true
    }
  })
  const receipt = {
    testId: 'A01-claude-explicit-config',
    attemptId,
    startedAt,
    endedAt: new Date().toISOString(),
    cwd,
    args,
    accountReference: 'system-explicit-config-dir',
    stdoutBytes,
    closed,
    ...result
  }
  await writeFile(
    join(process.cwd(), 'docs/workflows/evidence/a01-claude-explicit-config.json'),
    `${JSON.stringify(receipt, null, 2)}\n`
  )
  console.log(JSON.stringify(receipt, null, 2))
  process.exitCode = result.code === 0 && !result.timedOut && closed ? 0 : 1
}
void main()
