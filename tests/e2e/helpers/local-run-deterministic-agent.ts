import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFakeAgentCommandOverride } from './fake-agent-command-override'
import { FAKE_AGENT_PASTE_END_SCANNER_SOURCE } from './fake-agent-paste-end-scanner'

export type LocalRunAgentOperation = {
  nodeId: string
  token: string
  gatePath?: string
  predecessors?: { nodeId: string; token: string }[]
}

export type LocalRunAgentEvent = {
  event: 'spawn' | 'accepted' | 'consumed' | 'wrote' | 'reported' | 'error'
  pid: number
  at: number
  nodeId?: string
  taskId?: string
  dispatchId?: string
  terminalHandle?: string
  reportPath?: string
  outputPath?: string
  consumed?: { nodeId: string; path: string; contents: string }[]
  status?: number | null
  error?: string
}

const directory = mkdtempSync(path.join(os.tmpdir(), 'orca-local-run-agent-'))
const ledgerPath = path.join(directory, 'ledger.jsonl')
const executable = path.join(directory, process.platform === 'win32' ? 'codex.cmd' : 'codex')
const source = String.raw`
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const { spawnSync } = require('node:child_process')
if (process.argv.includes('app-server')) process.exit(2)
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.154.0-e2e\n')
  process.exit(0)
}
// Model discovery is a short-lived probe, not a dispatched worker. Answer the
// actual parser contract before installing a TTY loop or recording a spawn.
if (process.argv.includes('debug') && process.argv.includes('models')) {
  process.stdout.write(JSON.stringify({ models: [{
    slug: 'deterministic-e2e', display_name: 'Deterministic E2E',
    supported_reasoning_levels: [{ effort: 'low' }], default_reasoning_level: 'low'
  }] }) + '\n')
  process.exit(0)
}
const record = (event) => appendFileSync(process.env.ORCA_E2E_LOCAL_RUN_LEDGER,
  JSON.stringify({ pid: process.pid, at: Date.now(), ...event }) + '\n')
record({ event: 'spawn' })
process.stdout.write('\x1b]0;Codex Ready\x07OpenAI Codex\nmodel: deterministic-e2e\ndirectory: e2e\n')
let input = '', started = false
${FAKE_AGENT_PASTE_END_SCANNER_SOURCE}
function execute() {
  if (started) return
  started = true
  try {
    const encoded = input.match(/ORCA_E2E_LOCAL_RUN:([A-Za-z0-9+/=]+)/)?.[1]
    if (!encoded) throw new Error('Missing encoded local-run operation')
    const operation = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    const capability = input.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    const taskId = input.match(/Your task ID is: ([A-Za-z0-9_-]+)/)?.[1]
    const dispatchId = input.match(/--dispatch-id ([A-Za-z0-9_-]+)/)?.[1]
    const reportPath = [...input.matchAll(/^Report file: ([^\r\n]+)/gm)]
      .map((match) => match[1]).filter((value) => !value.includes('<run>')).at(-1)
    const outputDir = [...input.matchAll(/^Output folder: ([^\r\n]+)/gm)]
      .map((match) => match[1]).filter((value) => !value.includes('<run>')).at(-1)
    if (!capability || !taskId || !dispatchId || !reportPath || !outputDir) {
      throw new Error('Missing authenticated dispatch or runtime report paths')
    }
    const identity = { nodeId: operation.nodeId, taskId, dispatchId,
      terminalHandle: process.env.ORCA_TERMINAL_HANDLE }
    record({ event: 'accepted', ...identity })
    const complete = () => {
      try {
        const consumed = (operation.predecessors || []).map((predecessor) => {
          const report = 'LOCAL_RUN_REPORT ' + predecessor.nodeId + ' ' + predecessor.token
          if (!input.includes(report)) throw new Error('Missing predecessor report: ' + predecessor.nodeId)
          const prefix = 'LOCAL_RUN_FILE ' + predecessor.nodeId + ': '
          const line = input.split(/\r?\n/).find((entry) => entry.startsWith(prefix))
          if (!line) throw new Error('Missing predecessor file path: ' + predecessor.nodeId)
          const filePath = line.slice(prefix.length)
          const contents = readFileSync(filePath, 'utf8')
          if (contents !== predecessor.token + '\n') throw new Error('Changed predecessor bytes')
          return { nodeId: predecessor.nodeId, path: filePath, contents }
        })
        if (consumed.length) record({ event: 'consumed', ...identity, consumed })
        mkdirSync(outputDir, { recursive: true })
        const outputPath = join(outputDir, operation.nodeId + '.txt')
        writeFileSync(outputPath, consumed.length ? JSON.stringify(consumed) + '\n' : operation.token + '\n')
        mkdirSync(dirname(reportPath), { recursive: true })
        writeFileSync(reportPath, 'LOCAL_RUN_REPORT ' + operation.nodeId + ' ' + operation.token + '\n' +
          'LOCAL_RUN_FILE ' + operation.nodeId + ': ' + outputPath + '\n')
        record({ event: 'wrote', ...identity, outputPath, reportPath })
        const result = spawnSync(process.execPath, [process.env.ORCA_E2E_CLI_ENTRY,
          'orchestration', 'send', '--from', process.env.ORCA_TERMINAL_HANDLE,
          '--dispatch-capability', capability, '--type', 'worker_done', '--subject', 'Local node complete',
          '--body', 'Completed the deterministic node and wrote its report and artifact.',
          '--task-id', taskId, '--dispatch-id', dispatchId, '--outcome', 'succeeded',
          '--report-path', reportPath, '--files-modified', outputPath, '--json'],
          { env: process.env, encoding: 'utf8', timeout: 15000 })
        record({ event: 'reported', ...identity, status: result.status,
          ...(result.status === 0 ? {} : { error: result.stderr || String(result.error) }) })
        process.stdout.write('\x1b]0;Codex Ready\x07worker_done reported\n')
      } catch (error) {
        record({ event: 'error', ...identity, error: String(error) })
      }
    }
    if (!operation.gatePath || existsSync(operation.gatePath)) complete()
    else {
      const timer = setInterval(() => {
        if (!existsSync(operation.gatePath)) return
        clearInterval(timer)
        complete()
      }, 50)
    }
  } catch (error) { record({ event: 'error', error: String(error) }) }
}
process.stdin.on('data', (chunk) => {
  const current = chunk.toString()
  input += current
  const scan = scanFakeAgentPasteEnd(fakeAgentPasteEndTail, current)
  fakeAgentPasteEndTail = scan.tail
  process.stdout.write(current.replace(/\x1b\[20[01]~/g, ''))
  if (scan.pasteEndOffset !== null) process.stdout.write('\x1b[?25h')
  if (!started) fakeAgentMaybeAck(scan, current, (mode) => {
    if (mode !== 'bracketed') {
      record({ event: 'error', error: 'PASTE_PROTOCOL_ERROR' })
      return
    }
    process.stdout.write('\x1b]0;Codex Working\x07ACK\n')
    execute()
  })
})
process.stdin.setRawMode?.(true)
process.stdin.resume()
setInterval(() => {}, 60000)
`

writeFileSync(path.join(directory, 'agent.cjs'), source)
if (process.platform === 'win32') {
  writeFileSync(executable, '@echo off\r\nnode "%~dp0\\agent.cjs" %*\r\n')
} else {
  writeFileSync(executable, `#!/usr/bin/env node\n${source}`)
  chmodSync(executable, 0o755)
}

export const localRunAgentCommand = buildFakeAgentCommandOverride(executable)
export const localRunAgentEnv = {
  PATH: `${directory}${path.delimiter}${process.env.PATH ?? ''}`,
  ORCA_E2E_LOCAL_RUN_LEDGER: ledgerPath,
  ORCA_E2E_CLI_ENTRY: path.join(process.cwd(), 'out', 'cli', 'index.js')
}
export const localRunAgentGate = (nodeId: string): string => path.join(directory, nodeId)
export const localRunAgentInstruction = (operation: LocalRunAgentOperation): string =>
  `ORCA_E2E_LOCAL_RUN:${Buffer.from(JSON.stringify(operation)).toString('base64')}`
export const releaseLocalRunAgent = (nodeId: string): void =>
  writeFileSync(localRunAgentGate(nodeId), '')
export const cleanupLocalRunAgent = (): void => rmSync(directory, { recursive: true, force: true })

export function readLocalRunAgentLedger(): LocalRunAgentEvent[] {
  if (!existsSync(ledgerPath)) {
    return []
  }
  const text = readFileSync(ledgerPath, 'utf8')
  return text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LocalRunAgentEvent)
}
