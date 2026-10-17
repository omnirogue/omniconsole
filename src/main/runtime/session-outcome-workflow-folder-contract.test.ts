import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { canonicalDigestJson } from '../console-workflows/console-job-digests'
import { assertSessionOutcomeFolderLoopContract } from './session-outcome-workflow-folder-contract'
import { folderRoundFixture } from './session-outcome-workflow-folder-round-fixture'
import type { ConsoleWorkflowStep } from '../../shared/console-workflow-types'

function fixture(
  kind: 'folder' | 'git',
  mode: 'base' | 'review-source' = 'review-source',
  rounds: 1 | 2 | 3 = 2
) {
  const f = folderRoundFixture(mode)
  const graph = f.workflow.preview.graph
  if (rounds === 1) {
    graph.nodes = graph.nodes.filter(
      (node) => Number(node.loop_stage?.round) <= 1 && node.loop_stage?.role !== 'repair'
    )
  }
  if (rounds === 3) {
    const added = graph.nodes.filter(
      (node) =>
        node.loop_stage?.round === 2 ||
        (node.loop_stage?.role === 'repair' && node.loop_stage?.round === 1)
    )
    for (const original of added) {
      const node = structuredClone(original)
      node.loop_stage!.round = Number(original.loop_stage!.round) + 1
      node.key = `${original.key}_next`
      graph.nodes.push(node)
    }
  }
  for (const node of graph.nodes) {
    if (node.mechanical_execution) {
      node.mechanical_execution.input.max_rounds = rounds
      node.mechanical_execution.input.round = Number(node.loop_stage?.round)
      node.mechanical_execution.input.participant_node_keys = graph.nodes
        .filter(
          (entry) =>
            entry.loop_stage?.role === 'participant' &&
            entry.loop_stage?.round === node.loop_stage?.round
        )
        .map((entry) => entry.key)
    }
  }
  const source = structuredClone(graph.nodes[0]!.current_source!)
  const step: ConsoleWorkflowStep = {
    key: 'build',
    title: 'Review current files',
    actor: 'codex:gpt-5.6-terra',
    loop: {
      kind: 'review',
      participants: ['codex:gpt-6-astra', 'codex:gpt-5.6-sol'],
      max_rounds: rounds,
      stop_rule: 'zero_blockers'
    }
  }
  source.workspace =
    kind === 'folder'
      ? { kind, host: 'local', path: '/workspace/current' }
      : {
          kind,
          host: 'local',
          path: '/workspace/current',
          repo: 'https://gitlab.example/Team/Project.git',
          base_branch: 'main',
          base_sha: 'a'.repeat(40)
        }
  source.repair_producer = { provider: 'codex', model: 'gpt-5.6-terra' }
  if (kind === 'git') {
    source.git = { head_sha: 'a'.repeat(40), deleted_paths: ['docs/deleted.txt'] }
    source.snapshot_digest = createHash('sha256')
      .update(
        canonicalDigestJson({
          head_sha: source.git.head_sha,
          files: source.files.map(({ target_path, file }) => ({
            target_path,
            sha256: file.sha256,
            size_bytes: file.size_bytes
          })),
          deleted_paths: source.git.deleted_paths
        })
      )
      .digest('hex')
  }
  for (const node of graph.nodes) {
    node.current_source = structuredClone(source)
    node.source_files = structuredClone(source.files)
    if (node.actor_type !== 'ai') {
      continue
    }
    if (source.workspace.kind === 'git') {
      Object.assign(node, {
        repo: 'git@gitlab.example:team/project.git',
        base_branch: source.workspace.base_branch,
        base_sha: source.workspace.base_sha,
        source_deletions: [...source.git!.deleted_paths],
        source_overlay:
          node.loop_stage?.role === 'producer' ||
          (source.mode === 'review-source' && node.loop_stage?.round === 1)
      })
      delete node.workspace
    } else {
      node.workspace = structuredClone(source.workspace)
    }
  }
  const input = {
    ...structuredClone(f.workflow.currentInputs![0]!),
    ...(source.git ? { git: structuredClone(source.git) } : {})
  }
  return { graph, step, input, source }
}

it.each(['base', 'review-source'] as const)(
  'accepts local Git %s rounds using exact source files and normalized repository identity',
  (mode) => {
    const f = fixture('git', mode)
    expect(() => assertSessionOutcomeFolderLoopContract(f.graph, f.step, f.input)).not.toThrow()
  }
)
it('requires a typed snapshot review artifact for even one Git round', () => {
  const f = fixture('git', 'review-source', 1)
  expect(() => assertSessionOutcomeFolderLoopContract(f.graph, f.step, f.input)).not.toThrow()
  const review = f.graph.nodes.find((node) => node.loop_stage?.role === 'participant')!
  Object.assign(review, {
    artifact_result: { path: 'work-result.json', format: 'json', max_bytes: 65536 }
  })
  expect(() => assertSessionOutcomeFolderLoopContract(f.graph, f.step, f.input)).toThrow()
})
it.each(['explicit', 'legacy'] as const)(
  'preserves %s local folder loops alongside Git snapshots',
  (shape) => {
    const f = fixture('folder')
    if (shape === 'legacy') {
      for (const node of f.graph.nodes) {
        delete node.current_source!.workspace
        delete node.current_source!.repair_producer
      }
    }
    expect(() => assertSessionOutcomeFolderLoopContract(f.graph, f.step, f.input)).not.toThrow()
  }
)
it.each([
  { mode: 'base', role: 'producer', round: 0, overlay: true },
  { mode: 'base', role: 'participant', round: 1, overlay: false },
  { mode: 'base', role: 'participant', round: 2, overlay: false },
  { mode: 'base', role: 'repair', round: 1, overlay: false },
  { mode: 'base', role: 'repair', round: 2, overlay: false },
  { mode: 'review-source', role: 'participant', round: 1, overlay: true },
  { mode: 'review-source', role: 'participant', round: 2, overlay: false },
  { mode: 'review-source', role: 'repair', round: 1, overlay: true },
  { mode: 'review-source', role: 'repair', round: 2, overlay: false }
] as const)('pins Git overlay for $mode $role round $round', ({ mode, role, round, overlay }) => {
  const f = fixture('git', mode, 3)
  const node = f.graph.nodes.find(
    (entry) => entry.loop_stage?.role === role && entry.loop_stage?.round === round
  )!
  expect(node.source_overlay).toBe(overlay)
  expect(() => assertSessionOutcomeFolderLoopContract(f.graph, f.step, f.input)).not.toThrow()
  delete node.source_overlay
  expect(() => assertSessionOutcomeFolderLoopContract(f.graph, f.step, f.input)).toThrow()
  node.source_overlay = !overlay
  expect(() => assertSessionOutcomeFolderLoopContract(f.graph, f.step, f.input)).toThrow()
})
it.each([undefined, true, false])('preserves legacy folder overlay=%s', (overlay) => {
  const f = fixture('folder')
  for (const node of f.graph.nodes) {
    delete node.current_source!.workspace
    node.source_overlay = overlay
  }
  expect(() => assertSessionOutcomeFolderLoopContract(f.graph, f.step, f.input)).not.toThrow()
})
it.each([
  'repository-host',
  'base-branch',
  'base-sha',
  'workspace',
  'placement',
  'source-files',
  'source-deletions',
  'artifact',
  'artifact-limit',
  'action',
  'missing-repair',
  'repair-source'
] as const)('refuses Git loop %s drift before admission', (mutation) => {
  const f = fixture('git')
  const review = f.graph.nodes.find((node) => node.loop_stage?.role === 'participant')!
  if (mutation === 'repository-host') {
    review.repo = 'https://github.com/Team/Project.git'
  }
  if (mutation === 'base-branch') {
    review.base_branch = 'release'
  }
  if (mutation === 'base-sha') {
    review.base_sha = 'b'.repeat(40)
  }
  if (mutation === 'workspace') {
    review.workspace = { kind: 'folder', host: 'local', path: '/workspace/current' }
  }
  if (mutation === 'placement') {
    review.placement = 'fleet'
  }
  if (mutation === 'source-files') {
    review.source_files![0]!.target_path = 'unselected.txt'
  }
  if (mutation === 'source-deletions') {
    review.source_deletions = ['unselected.txt']
  }
  if (mutation === 'artifact') {
    Object.assign(review, {
      artifact_result: { path: 'work-result.json', format: 'json', max_bytes: 65536 }
    })
  }
  if (mutation === 'artifact-limit') {
    Object.assign(review, {
      artifact_result: { path: 'folder-review.json', format: 'json', max_bytes: 65537 }
    })
  }
  if (mutation === 'action') {
    review.action = 'execute'
  }
  if (mutation === 'missing-repair') {
    f.graph.nodes = f.graph.nodes.filter((node) => node.loop_stage?.role !== 'repair')
  }
  if (mutation === 'repair-source') {
    const repair = f.graph.nodes.find((node) => node.loop_stage?.role === 'repair')!
    repair.current_source!.repair_producer!.model = 'unselected-model'
  }
  expect(() => assertSessionOutcomeFolderLoopContract(f.graph, f.step, f.input)).toThrow()
})
it('refuses an explicit folder source bound to a different local folder', () => {
  const f = fixture('folder')
  const review = f.graph.nodes.find((node) => node.loop_stage?.role === 'participant')!
  review.workspace = { kind: 'folder', host: 'local', path: '/workspace/other' }
  expect(() => assertSessionOutcomeFolderLoopContract(f.graph, f.step, f.input)).toThrow()
})
it('refuses a Git source with a frozen HEAD different from its base', () => {
  const f = fixture('git')
  for (const node of f.graph.nodes) {
    node.current_source!.git!.head_sha = 'b'.repeat(40)
  }
  f.input.git!.head_sha = 'b'.repeat(40)
  expect(() => assertSessionOutcomeFolderLoopContract(f.graph, f.step, f.input)).toThrow()
})
