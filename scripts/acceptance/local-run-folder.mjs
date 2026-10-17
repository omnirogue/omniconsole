#!/usr/bin/env node
// Phase 2 acceptance: drive a running OmniConsole dev instance through the local DAG
// runner on a FOLDER workspace (a video brief plus source clips), with a different
// actor on every node, and print the node states, the manifests and the exact input
// the synthesize node received.
//
// Usage:
//   node scripts/acceptance/local-run-folder.mjs <userDataPath> [workspacePath]
//
// <userDataPath> is the ORCA_USER_DATA_PATH the dev instance was started with.
// Without <workspacePath> a fixture folder is created under fixtures/local-run-video.
//
// It never creates a card, never binds a hub task and never touches git.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { localRunAcceptanceGraph } from './local-run-folder-graph.mjs'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const [, , userDataPath, workspaceArg] = process.argv

if (!userDataPath) {
  console.error(
    'Usage: node scripts/acceptance/local-run-folder.mjs <userDataPath> [workspacePath]'
  )
  process.exit(2)
}

const { RuntimeClient } = await import(join(repoRoot, 'out/cli/runtime/index.js'))

/** A folder workspace with a brief and source clips. Git optional means: no git here. */
function ensureFixture() {
  if (workspaceArg) {
    return resolve(workspaceArg)
  }
  const path = join(repoRoot, 'fixtures', 'local-run-video')
  mkdirSync(join(path, 'clips'), { recursive: true })
  writeFileSync(
    join(path, 'brief.md'),
    [
      '# Promo brief',
      '',
      'Cut a 30 second promo from the clips in ./clips.',
      'Three variations, then one assembled cut, then a check against this brief.',
      ''
    ].join('\n')
  )
  for (const name of ['opening.mp4', 'demo.mp4', 'closing.mp4']) {
    const clip = join(path, 'clips', name)
    if (!existsSync(clip)) {
      writeFileSync(clip, `placeholder bytes for ${name}\n`)
    }
  }
  return path
}

const workspacePath = ensureFixture()

const graph = localRunAcceptanceGraph(workspacePath)

const client = new RuntimeClient(userDataPath, 120_000)
const call = async (method, params) => (await client.call(method, params)).result

/** One line per node: the derived state, why it is in that state, and where it runs. */
function printStates(run) {
  const width = Math.max(...run.nodes.map((node) => node.id.length))
  for (const node of run.nodes) {
    const actor = [node.actor.agent, node.actor.model, node.actor.effort].filter(Boolean).join('/')
    const placement = node.placement
      ? node.placement.cwd
        ? `cwd=${node.placement.cwd}`
        : `workspace=${node.placement.worktree}${node.placement.name ? `:${node.placement.name}` : ''}`
      : 'workspace=(not placed)'
    console.log(
      `  ${node.id.padEnd(width)}  ${node.state.toUpperCase().padEnd(11)} ${describeWhy(node).padEnd(26)} ${actor.padEnd(24)} ${placement}`
    )
  }
}

/** What the state was derived FROM, so a stuck run names its own reason in the table. */
function describeWhy(node) {
  if (node.question) {
    return node.question.source === 'terminal' ? 'asked in its terminal' : 'asked the run mailbox'
  }
  if (node.state === 'needs-input') {
    return `gate ${node.gateId ?? '(none)'}`
  }
  if (node.dispatchId) {
    return `dispatch ${node.dispatchId}`
  }
  return node.taskId ? `task ${node.taskId}` : 'no task yet'
}

console.log(`workspace: ${workspacePath}`)
const { run: created } = await call('localRun.create', { graph })
console.log(`local run: ${created.id} (${created.nodes.length} nodes)`)
await call('localRun.start', { id: created.id })

let run = created
const deadline = Date.now() + 60 * 60 * 1000
while (Date.now() < deadline) {
  await new Promise((resolvePoll) => setTimeout(resolvePoll, 3_000))
  ;({ run } = await call('localRun.status', { id: created.id }))
  console.log(`\n[${new Date().toISOString()}] stage=${run.stage}`)
  printStates(run)
  const waiting = run.nodes.filter((node) => node.state === 'needs-input')
  for (const node of waiting) {
    console.log(`  NEEDS INPUT on ${node.id}: ${node.question?.question ?? node.gateQuestion}`)
    console.log(
      node.question
        ? `    answer with: localRun.reply { id: '${run.id}', messageId: '${node.question.messageId}', body: '…' }`
        : `    answer with: localRun.resolveGate { id: '${run.id}', gateId: '${node.gateId}', resolution: '…' }`
    )
  }
  if (['completed', 'failed', 'cancelled'].includes(run.stage)) {
    break
  }
}

console.log(`\nfinal stage: ${run.stage}${run.error ? ` — ${run.error}` : ''}`)
console.log(`orchestration run: ${run.runId}`)

console.log('\nmanifests and produced files')
for (const node of run.nodes) {
  console.log(`  ${node.id}`)
  console.log(`    report:   ${node.reportPath ?? '(none)'}`)
  console.log(
    `    manifest: ${node.manifestPath ?? '(none)'}${node.manifestPath && existsSync(node.manifestPath) ? '' : '  [MISSING]'}`
  )
  for (const file of node.producedFiles) {
    console.log(`    file:     ${file}`)
  }
}

const assemble = run.nodes.find((node) => node.id === 'assemble')
console.log('\nsynthesize input (what the assemble node was handed)')
for (const dependency of ['cut-a', 'cut-b', 'cut-c']) {
  const node = run.nodes.find((entry) => entry.id === dependency)
  console.log(`  from ${dependency} (manifest: ${node?.manifestPath ?? '(none)'})`)
  for (const file of node?.producedFiles ?? []) {
    console.log(`    ${file}`)
  }
  if (node?.reportPath && existsSync(node.reportPath)) {
    const head = readFileSync(node.reportPath, 'utf8').split('\n').slice(0, 12).join('\n    ')
    console.log(`    report head:\n    ${head}`)
  }
}
console.log(`\nassemble output folder: ${assemble?.outputDir ?? '(none)'}`)

console.log('\nrun log')
for (const event of run.events) {
  console.log(`  ${event.at} ${event.kind.padEnd(7)} ${event.node.padEnd(10)} ${event.text}`)
}

process.exit(run.stage === 'completed' ? 0 : 1)
