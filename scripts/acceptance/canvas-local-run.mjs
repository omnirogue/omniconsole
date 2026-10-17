#!/usr/bin/env node
// Phase 3 acceptance: drive a running OmniConsole dev instance through exactly what the
// canvas does — seed the "Fan-out → Synthesize" template on a FOLDER workspace, save the
// graph beside automations, read it back (the round-trip a restart has to survive),
// create the run from that saved graph, and print every step with the folder it ran in
// and the files it produced.
//
// Usage:
//   node scripts/acceptance/canvas-local-run.mjs <userDataPath> [options]
//     --workspace <path>   an existing folder to run in (default: fixtures/canvas-fan-out)
//     --branches <n>       fan-out width (default 3)
//     --start              actually start the workers. WITHOUT this flag nothing is
//                          launched and no agent session is spent: the script only
//                          proves the canvas payloads are accepted by a real runtime.
//
// <userDataPath> is the ORCA_USER_DATA_PATH the dev instance was started with.
// It never creates a card, never binds a hub task and never touches git.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const [, , userDataPath, ...rest] = process.argv

if (!userDataPath || userDataPath.startsWith('--')) {
  console.error('Usage: node scripts/acceptance/canvas-local-run.mjs <userDataPath> [options]')
  process.exit(2)
}

function flag(name, fallback) {
  const index = rest.indexOf(`--${name}`)
  return index === -1 ? fallback : rest[index + 1]
}

const shouldStart = rest.includes('--start')
const branches = Number.parseInt(flag('branches', '3'), 10)

const { RuntimeClient } = await import(join(repoRoot, 'out/cli/runtime/index.js'))
// The same seed the canvas offers, not a copy of it: a template the runner would refuse
// is not acceptance evidence.
const { localRunTemplateGraph } = await import(join(repoRoot, 'out/shared/local-run-templates.js'))

/** A plain folder of material. Git optional means: there is no repository here. */
function ensureFixture() {
  const provided = flag('workspace', null)
  if (provided) {
    return resolve(provided)
  }
  const path = join(repoRoot, 'fixtures', 'canvas-fan-out')
  mkdirSync(join(path, 'clips'), { recursive: true })
  writeFileSync(
    join(path, 'brief.md'),
    ['# Opener brief', '', 'Cut a 45 second opener from the clips in ./clips.', ''].join('\n')
  )
  for (const name of ['a.mp4', 'b.mp4', 'c.mp4']) {
    const clip = join(path, 'clips', name)
    if (!existsSync(clip)) {
      writeFileSync(clip, `placeholder bytes for ${name}\n`)
    }
  }
  return path
}

const workspacePath = ensureFixture()
const client = new RuntimeClient(userDataPath, 120_000)
const call = async (method, params) => (await client.call(method, params)).result

const graph = localRunTemplateGraph('fan-out-synthesize', {
  workspacePath,
  actor: { agent: 'codex' },
  objective: 'Cut a 45 second opener from the clips in ./clips.',
  count: branches
})

console.log(`workspace (folder, no git): ${workspacePath}`)
console.log(`template: fan-out-synthesize · ${graph.nodes.length} steps`)
for (const node of graph.nodes) {
  console.log(`  ${node.id.padEnd(12)} ${node.presetId.padEnd(11)} after=[${node.deps.join(', ')}]`)
}

// 1. Save the graph beside automations, exactly as the canvas's "Save graph" does.
const draftId = `acceptance-fan-out-${Date.now().toString(36)}`
await call('localRun.saveDraft', { id: draftId, title: 'Acceptance fan-out', graph })
const { drafts } = await call('localRun.listDrafts', {})
const saved = drafts.find((entry) => entry.id === draftId)
if (!saved) {
  console.error('FAIL: the saved graph did not come back from localRun.listDrafts')
  process.exit(1)
}
console.log(`\nsaved graph round-trip: ${saved.id} — "${saved.title}"`)
console.log(`  workspacePath: ${saved.graph.workspacePath}`)
console.log(`  steps:         ${saved.graph.nodes.map((node) => node.id).join(', ')}`)
if (saved.graph.nodes.length !== graph.nodes.length) {
  console.error('FAIL: the saved graph came back with a different number of steps')
  process.exit(1)
}

// 2. Create the run from the graph that came back, not from the one in memory.
const { run: created } = await call('localRun.create', { graph: saved.graph })
console.log(`\nlocal run: ${created.id} (${created.nodes.length} steps, stage=${created.stage})`)

function printSteps(run) {
  const width = Math.max(...run.nodes.map((node) => node.id.length))
  for (const node of run.nodes) {
    const actor = [node.actor.agent, node.actor.model, node.actor.effort].filter(Boolean).join('/')
    const folder = node.placement?.cwd ?? run.workspacePath
    console.log(
      `  ${node.id.padEnd(width)}  ${node.state.toUpperCase().padEnd(11)} ${actor.padEnd(18)} ${folder}`
    )
    for (const file of node.producedFiles) {
      console.log(`  ${' '.repeat(width)}  produced: ${file}`)
    }
  }
}

if (!shouldStart) {
  printSteps(created)
  console.log(
    '\nNot started: pass --start to launch the workers. Every step is a real agent session,' +
      '\nso this script never spends one without being asked.'
  )
  await call('localRun.cancel', { id: created.id }).catch(() => undefined)
  process.exit(0)
}

await call('localRun.start', { id: created.id })
let run = created
const deadline = Date.now() + 60 * 60 * 1000
while (Date.now() < deadline) {
  await new Promise((wait) => setTimeout(wait, 3_000))
  ;({ run } = await call('localRun.status', { id: created.id }))
  console.log(`\n[${new Date().toISOString()}] stage=${run.stage}`)
  printSteps(run)
  for (const node of run.nodes.filter((entry) => entry.state === 'needs-input')) {
    console.log(`  NEEDS INPUT on ${node.id}: ${node.question?.question ?? node.gateQuestion}`)
  }
  if (['completed', 'failed', 'cancelled'].includes(run.stage)) {
    break
  }
}

console.log(`\nfinal stage: ${run.stage}${run.error ? ` — ${run.error}` : ''}`)
console.log('\nmanifests and produced files')
for (const node of run.nodes) {
  console.log(`  ${node.id}`)
  console.log(`    folder:   ${node.placement?.cwd ?? run.workspacePath}`)
  console.log(`    manifest: ${node.manifestPath ?? '(none)'}`)
  for (const file of node.producedFiles) {
    console.log(`    file:     ${file}`)
  }
}
console.log('\nrun log')
for (const event of run.events) {
  console.log(`  ${event.at} ${event.kind.padEnd(7)} ${event.node.padEnd(12)} ${event.text}`)
}

process.exit(run.stage === 'completed' ? 0 : 1)
