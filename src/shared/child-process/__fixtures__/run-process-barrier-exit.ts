import { runProcess } from '../run-process'

async function main(): Promise<void> {
  const root = `
    const { spawn } = require('node:child_process')
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', process.stdout, process.stderr]
    })
    setInterval(() => {}, 1000)
  `
  const result = await runProcess({
    program: process.execPath,
    args: ['-e', root],
    timeoutMs: 150,
    terminationBarrier: true
  })
  process.stdout.write(JSON.stringify({ settled: true, timedOut: result.timedOut }))
}

void main()
