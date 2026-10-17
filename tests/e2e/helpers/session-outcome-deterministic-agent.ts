import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFakeAgentCommandOverride } from './fake-agent-command-override'
import { FAKE_AGENT_PASTE_END_SCANNER_SOURCE } from './fake-agent-paste-end-scanner'

export type DeterministicOutcomeAgentEvent = {
  event: 'spawn' | 'input' | 'accepted' | 'wrote' | 'reported' | 'source-hook'
  pid: number
  outcomeId?: string
  taskId?: string
  dispatchId?: string
  receipt?: string
  input?: string
  status?: number | null
  stderr?: string
  sourceState?: 'working' | 'interrupted' | 'done'
}

export type DeterministicOutcomeInstruction = {
  outcomeId: string
  outputPath: string
  contents: string
  gatePath?: string
}

const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'orca-outcome-agent-'))
const ledgerPath = path.join(fixtureDir, 'ledger.jsonl')
const sourceControlPath = path.join(fixtureDir, 'source-control.json')
const cliEntry = path.join(process.cwd(), 'out', 'cli', 'index.js')
const executable = path.join(fixtureDir, process.platform === 'win32' ? 'codex.cmd' : 'codex')
const scriptPath = path.join(fixtureDir, 'deterministic-agent.cjs')

// This is deliberately not an inference stub: it implements one encoded file-write
// operation and settles through the same authenticated CLI path as a dispatched agent.
const source = String.raw`
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname } = require('node:path')
const { spawnSync } = require('node:child_process')
if (process.argv.slice(2).includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\n")
  process.exit(2)
}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.154.0-e2e\n')
  process.exit(0)
}
// Discovery probes must finish before recording a worker or installing its TTY
// loop. This is the models[].slug/display_name schema read by parseCodexModels.
if (process.argv.includes('debug') && process.argv.includes('models')) {
  process.stdout.write(JSON.stringify({ models: [{
    slug: 'deterministic-e2e', display_name: 'Deterministic E2E',
    supported_reasoning_levels: [{ effort: 'low' }], default_reasoning_level: 'low'
  }] }) + '\n')
  process.exit(0)
}
const ledger = process.env.ORCA_E2E_OUTCOME_AGENT_LEDGER
const record = (event) => appendFileSync(ledger, JSON.stringify({ pid: process.pid, ...event }) + '\n')
const sourceMode = process.argv.includes('--outcome-source')
record({ event: 'spawn' })
process.stdout.write(
  sourceMode
    ? '\u001b]0;Cursor Ready\u0007Deterministic outcome agent\nmodel: deterministic-e2e\ndirectory: task-local\n'
    : '\u001b]0;Codex Ready\u0007OpenAI Codex\nmodel: deterministic-e2e\ndirectory: task-local\n'
)
if (sourceMode) {
  let lastControl = ''
  let sending = false
  setInterval(async () => {
    const controlPath = process.env.ORCA_E2E_OUTCOME_SOURCE_CONTROL
    if (sending || !controlPath || !existsSync(controlPath)) return
    let control, state
    try {
      control = readFileSync(controlPath, 'utf8')
      state = JSON.parse(control).state
    } catch { return }
    if (control === lastControl) return
    lastControl = control
    sending = true
    try {
      const response = await fetch('http://127.0.0.1:' + process.env.ORCA_AGENT_HOOK_PORT + '/hook/cursor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': process.env.ORCA_AGENT_HOOK_TOKEN },
        body: JSON.stringify({
          paneKey: process.env.ORCA_PANE_KEY,
          tabId: process.env.ORCA_TAB_ID,
          worktreeId: process.env.ORCA_WORKTREE_ID,
          env: process.env.ORCA_AGENT_HOOK_ENV,
          version: process.env.ORCA_AGENT_HOOK_VERSION,
          launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN,
          payload: state === 'working'
            ? { hook_event_name: 'beforeSubmitPrompt', prompt: 'Complete the disposable outcome source' }
            : { hook_event_name: 'stop', status: state === 'interrupted' ? 'cancelled' : 'completed', last_assistant_message: 'Source ' + state }
        })
      })
      record({ event: 'source-hook', sourceState: state, status: response.status })
    } catch (error) {
      record({ event: 'source-hook', sourceState: state, stderr: String(error) })
    } finally {
      sending = false
    }
  }, 50)
}
let input = ''
let started = false
let acknowledged = false
let submitted = false
${FAKE_AGENT_PASTE_END_SCANNER_SOURCE}
process.stdin.on('data', (chunk) => {
  const current = chunk.toString()
  record({ event: 'input', input: current })
  input += current
  const paste = scanFakeAgentPasteEnd(fakeAgentPasteEndTail, current)
  fakeAgentPasteEndTail = paste.tail
  // A real Codex TUI redraws the composer while a long bracketed paste streams.
  process.stdout.write(current.replace(/\x1b\[20[01]~/g, ''))
  if (!acknowledged) {
    fakeAgentMaybeAck(paste, current, (mode) => {
      acknowledged = true
      submitted = true
      const message = mode === 'bracketed' ? 'ACK' : 'PASTE_PROTOCOL_ERROR'
      process.stdout.write('\u001b]0;Codex Working\u0007' + message + '\n')
      setTimeout(() => process.stdout.write('\u001b]0;Codex Ready\u0007'), 10)
    })
  }
  if (started || !submitted) return
  const encoded = input.match(/ORCA_E2E_OUTCOME_WRITE:([A-Za-z0-9+/=]+)/)?.[1]
  const capability = input.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
  const taskId = input.match(/Your task ID is: ([A-Za-z0-9_-]+)/)?.[1]
  const dispatchId = input.match(/--dispatch-id ([A-Za-z0-9_-]+)/)?.[1]
  if (!encoded || !capability || !taskId || !dispatchId) return
  const operation = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  started = true
  record({ event: 'accepted', outcomeId: operation.outcomeId, taskId, dispatchId })
  const complete = () => {
    mkdirSync(dirname(operation.outputPath), { recursive: true })
    writeFileSync(operation.outputPath, operation.contents)
    record({ event: 'wrote', outcomeId: operation.outcomeId, taskId, dispatchId })
    const result = spawnSync(process.execPath, [process.env.ORCA_E2E_CLI_ENTRY,
      'orchestration', 'send', '--from', process.env.ORCA_TERMINAL_HANDLE,
      '--dispatch-capability', capability, '--type', 'worker_done', '--subject', 'File produced',
      '--body', 'Performed the deterministic task-local file write. The requested bytes are on disk. No external provider or recipient was contacted.',
      '--task-id', taskId, '--dispatch-id', dispatchId, '--outcome', 'succeeded',
      '--files-modified', operation.outputPath, '--json'], { env: process.env, encoding: 'utf8' })
    record({ event: 'reported', outcomeId: operation.outcomeId, taskId, dispatchId,
      receipt: result.stdout.trim(), status: result.status, stderr: result.stderr.trim() })
    if (result.status !== 0) process.exitCode = 2
    process.stdout.write('\u001b]0;Codex Ready\u0007worker_done reported\n')
  }
  if (!operation.gatePath || existsSync(operation.gatePath)) complete()
  else {
    const timer = setInterval(() => {
      if (!existsSync(operation.gatePath)) return
      clearInterval(timer)
      complete()
    }, 50)
  }
})
process.stdin.setRawMode?.(true)
process.stdin.resume()
setInterval(() => {}, 60000)
`

function installDeterministicOutcomeAgent(): void {
  mkdirSync(fixtureDir, { recursive: true })
  writeFileSync(scriptPath, source)
  if (process.platform === 'win32') {
    writeFileSync(executable, `@echo off\r\nnode "%~dp0\\deterministic-agent.cjs" %*\r\n`)
  } else {
    writeFileSync(executable, `#!/usr/bin/env node\n${source}`)
    chmodSync(executable, 0o755)
  }
}
installDeterministicOutcomeAgent()

export const deterministicOutcomeAgentCommand = buildFakeAgentCommandOverride(executable)

export function deterministicOutcomeAgentEnv(): NodeJS.ProcessEnv {
  return {
    PATH: `${fixtureDir}${path.delimiter}${process.env.PATH ?? ''}`,
    ORCA_E2E_CLI_ENTRY: cliEntry,
    ORCA_E2E_OUTCOME_AGENT_LEDGER: ledgerPath,
    ORCA_E2E_OUTCOME_SOURCE_CONTROL: sourceControlPath
  }
}

export function encodedOutcomeInstruction(operation: DeterministicOutcomeInstruction): string {
  return `ORCA_E2E_OUTCOME_WRITE:${Buffer.from(JSON.stringify(operation)).toString('base64')}`
}

export function clearDeterministicOutcomeAgentLedger(): void {
  // Playwright can reuse this module after another spec's afterAll removed its executable.
  installDeterministicOutcomeAgent()
  rmSync(ledgerPath, { force: true })
  rmSync(sourceControlPath, { force: true })
}

export function setDeterministicOutcomeSourceState(
  state: 'working' | 'interrupted' | 'done'
): void {
  writeFileSync(sourceControlPath, JSON.stringify({ state, sequence: Date.now() }))
}

export function readDeterministicOutcomeAgentLedger(): DeterministicOutcomeAgentEvent[] {
  if (!existsSync(ledgerPath)) {
    return []
  }
  const text = readFileSync(ledgerPath, 'utf8')
  const complete = text.slice(0, text.lastIndexOf('\n') + 1)
  return complete
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DeterministicOutcomeAgentEvent)
}

export function cleanupDeterministicOutcomeAgent(): void {
  rmSync(fixtureDir, { recursive: true, force: true })
}
