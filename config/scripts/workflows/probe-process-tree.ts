import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcess } from '../../../src/shared/child-process/run-process'

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error('POSIX fixture only; Windows route not certified')
  }
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-tree-'))
  const ledger = join(cwd, 'spawns.jsonl')
  const controller = new AbortController()
  let closed = false
  const resultPromise = runProcess({
    program: process.execPath,
    args: [resolve('config/scripts/workflows/fixtures/headless-tree.cjs'), ledger],
    cwd,
    signal: controller.signal,
    timeoutMs: 15_000,
    terminationBarrier: true,
    onChildTerminated: () => {
      closed = true
    }
  })
  let launches: { role: string; pid: number; parentPid: number }[] = []
  const deadline = Date.now() + 10_000
  while (launches.length < 3 && Date.now() < deadline) {
    launches = (await readFile(ledger, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    if (launches.length < 3) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  controller.abort()
  const result = await resultPromise
  const probe = await runProcess({
    program: 'ps',
    args: ['-p', launches.map((entry) => entry.pid).join(','), '-o', 'pid=,stat='],
    timeoutMs: 5_000
  })
  const states = probe.stdout.trim().split('\n').filter(Boolean)
  const live = states.filter((line) => !/^\s*\d+\s+Z/.test(line))
  const passed =
    launches.length === 3 &&
    closed &&
    !probe.timedOut &&
    [0, 1].includes(probe.code ?? -1) &&
    live.length === 0
  const evidence = {
    testId: 'A05-posix-tree',
    status: passed ? 'pass' : 'fail',
    launches,
    closed,
    result,
    probe,
    ledger,
    scope:
      'One POSIX process group; descendants retain stdout and ignore TERM. Escaped process groups are not certified.'
  }
  await writeFile(
    'docs/workflows/evidence/a05-posix-tree.json',
    `${JSON.stringify(evidence, null, 2)}\n`
  )
  console.log(JSON.stringify(evidence, null, 2))
  process.exitCode = passed ? 0 : 1
}
void main()
