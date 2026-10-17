import { realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { runProcess } from '../../shared/child-process/run-process'
import {
  getFreshProcessTableSnapshot,
  type ProcessTableRow
} from '../../shared/process-table-snapshot'
import type { TerminalAgentProcessProof } from '../../shared/pty-agent-process-evidence'
import type { RuntimeTerminalResolvePane } from '../../shared/runtime-terminal-contracts'
import { queueBoundCodexMessage, type PeerInboxCodexQueueResult } from './peer-inbox-codex-queue'

/** The open writer lock and queue, never a selected account or a copied transcript, pin routing. */
export function codexQueueHomeFromOpenFiles(
  output: string,
  threadId: string,
  proof: TerminalAgentProcessProof,
  rows: readonly ProcessTableRow[]
): string | null {
  const files = new Map<number, Set<string>>()
  let pid = 0
  for (const line of output.split(/\r?\n/)) {
    if (/^p\d+$/.test(line)) {
      pid = Number(line.slice(1))
      files.set(pid, new Set())
    } else if (pid && line.startsWith('n')) {
      files.get(pid)?.add(line.slice(1))
    }
  }
  const found: string[] = []
  for (const [writer, paths] of files) {
    const row = rows.find((candidate) => candidate.pid === writer)
    if (
      !row ||
      (writer !== proof.pid && row.ppid !== proof.pid) ||
      !row.stat.includes('+') ||
      row.stat.includes('T') ||
      recognizeAgentProcessFromCommandLine(row.command)?.agent !== 'codex'
    ) {
      continue
    }
    for (const path of paths) {
      if (!path.endsWith(`/thread-writer-locks/${threadId}.lock`)) {
        continue
      }
      const home = dirname(dirname(path))
      if (paths.has(join(home, 'queue_1.sqlite'))) {
        found.push(home)
      }
    }
  }
  return found.length === 1 ? found[0]! : null
}

/** Local execution only. Remote process ids must never be resolved on the controller. */
export async function queueCodexTerminalNotice(input: {
  terminal: RuntimeTerminalResolvePane
  proof: TerminalAgentProcessProof
  threadId: string
  hint: string
  correlationNonce: string
  assertCurrent(): Promise<void>
  /** Persist an uncertain/in-flight receipt BEFORE crossing the native queue boundary. */
  prepare(): boolean
}): Promise<PeerInboxCodexQueueResult> {
  const { terminal, proof, threadId } = input
  const refused = { status: 'not-started' as const, reason: 'native-writer-unverifiable' }
  if (
    process.platform === 'win32' ||
    terminal.executionHostId !== 'local' ||
    !terminal.connected ||
    terminal.ptyId !== proof.ptyId ||
    proof.agent !== 'codex' ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(threadId)
  ) {
    return refused
  }
  let home: string
  try {
    await input.assertCurrent()
    const rows = await getFreshProcessTableSnapshot()
    const pids = rows
      .filter((row) => row.pid === proof.pid || row.ppid === proof.pid)
      .map((row) => row.pid)
    if (!pids.length) {
      return refused
    }
    const files = await runProcess({
      program: process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof',
      args: ['-n', '-P', '-a', '-p', pids.join(','), '-F', 'pn'],
      timeoutMs: 5000,
      maxOutputBytes: 512 * 1024
    })
    if (files.code !== 0 || files.timedOut || files.signal) {
      return refused
    }
    const observed = codexQueueHomeFromOpenFiles(files.stdout, threadId, proof, rows)
    if (!observed) {
      return refused
    }
    home = await realpath(observed)
    const queue = await stat(join(home, 'queue_1.sqlite'))
    if (!queue.isFile() || queue.uid !== process.getuid?.()) {
      return refused
    }
    await input.assertCurrent()
    if (!input.prepare()) {
      return refused
    }
  } catch {
    return refused
  }
  return queueBoundCodexMessage({
    accountHome: home,
    sqliteHome: home,
    threadId,
    hint: input.hint,
    correlationNonce: input.correlationNonce
  })
}
