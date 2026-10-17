#!/usr/bin/env node
// Acceptance: auto-advance for one console-admitted research → plan → build workflow.
//
// Drives a RUNNING dev instance through the runtime client, exactly as a person would drive the
// Jobs view: turn auto-advance on for one named workflow, then let it activate the next ready
// LOCAL job after each published result until a human decision (or another stop) ends the chain.
// It never names a job itself and never claims work: every activation is chosen by the same
// admitted projection the IDE reads, and performed by the same named local start a click uses.
//
// Requires a signed-in OmniConsole session in the target profile. Without one, every console read
// refuses and this script prints the refusal instead of inventing a run.
//
// Usage:
//   pnpm run build:cli
//   node scripts/acceptance/console-auto-advance.mjs \
//     --user-data "$HOME/Library/Application Support/OmniConsole" \
//     --workflow wf_xxx --worktree id:<worktree-id> [--minutes 20]

import { RuntimeClient } from '../../out/cli/runtime/index.js'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1])
}
const workflowId = args.get('workflow')
const worktree = args.get('worktree')
const userDataPath = args.get('user-data')
const minutes = Number(args.get('minutes') ?? 20)
if (!workflowId || !worktree || !userDataPath) {
  console.error(
    'Usage: --user-data <path> --workflow wf_… --worktree id:<worktree-id> [--minutes n]'
  )
  process.exit(2)
}
if (worktree.startsWith('id:folder:')) {
  console.error('Folder workspaces are refused: the admitted local path is Git-only.')
  process.exit(2)
}

const client = new RuntimeClient(userDataPath)
const stamp = () => new Date().toISOString()
const line = (text) => console.log(`${stamp()} ${text}`)

async function call(method, params) {
  try {
    const response = await client.call(method, params)
    return { ok: true, result: response.result }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

const enabled = await call('consoleWorkflow.autoAdvanceSet', {
  workflowId,
  enabled: true,
  worktree
})
if (!enabled.ok) {
  line(`REFUSED enabling auto-advance: ${enabled.message}`)
  process.exit(1)
}
line(`auto-advance ON for ${workflowId} in ${worktree}`)

const deadline = Date.now() + minutes * 60_000
const activated = []
let last = null
try {
  while (Date.now() < deadline) {
    const cycle = await call('consoleWorkflow.autoAdvanceRun', { workflowId })
    if (!cycle.ok) {
      line(`REFUSED cycle: ${cycle.message}`)
      break
    }
    const status = cycle.result.status
    if (status.state === 'activated' && status.jobId && !activated.includes(status.jobId)) {
      activated.push(status.jobId)
      line(`ACTIVATED ${status.jobId} (local, named activation path)`)
    } else if (JSON.stringify(status) !== JSON.stringify(last)) {
      line(
        `${status.state}${status.reason ? `: ${status.reason}` : ''}${status.detail ? ` — ${status.detail}` : ''}`
      )
    }
    last = status
    if (status.state === 'stopped' || status.state === 'off') {
      line(
        `FINAL ${status.state}: ${status.reason ?? 'none'}${status.jobId ? ` at ${status.jobId}` : ''}`
      )
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
} finally {
  const off = await call('consoleWorkflow.autoAdvanceSet', { workflowId, enabled: false })
  line(`auto-advance OFF (${off.ok ? 'confirmed' : off.message})`)
}
line(`activations: ${activated.length ? activated.join(', ') : 'none'}`)
