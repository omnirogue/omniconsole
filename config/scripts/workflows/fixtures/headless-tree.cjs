const { appendFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const [ledger, role = 'root'] = process.argv.slice(2)
appendFileSync(ledger, `${JSON.stringify({ role, pid: process.pid, parentPid: process.ppid })}\n`)
if (role !== 'grandchild') {
  spawn(process.execPath, [__filename, ledger, role === 'root' ? 'child' : 'grandchild'], {
    stdio: ['ignore', 'inherit', 'inherit']
  })
}
process.on('SIGTERM', () => {
  if (role === 'root') {
    process.exit(0)
  }
})
setInterval(() => {}, 1000)
