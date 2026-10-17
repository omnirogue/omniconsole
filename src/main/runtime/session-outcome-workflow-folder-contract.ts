import { isDeepStrictEqual } from 'node:util'
import { consoleJobRepositoryIdentity } from '../console-workflows/console-job-repository-identity'
import type { ConsoleWorkflowGraph, ConsoleWorkflowStep } from '../../shared/console-workflow-types'
import type { SessionOutcomeCurrentInput } from '../../shared/session-outcome-current-inputs'
type CurrentSource = NonNullable<ConsoleWorkflowGraph['nodes'][number]['current_source']>

function sortedDistinctPaths(paths: string[]): boolean {
  return paths.every(
    (path, index) =>
      index === 0 || Buffer.compare(Buffer.from(paths[index - 1]!), Buffer.from(path)) < 0
  )
}

export function sessionOutcomeCurrentInputMatches(
  source: CurrentSource,
  input: SessionOutcomeCurrentInput
): boolean {
  const paths = source.files.map((file) => file.target_path)
  const deleted = source.git?.deleted_paths ?? []
  return (
    source.mode === input.mode &&
    source.stage_key === input.stage_key &&
    isDeepStrictEqual(source.git, input.git) &&
    (!source.git ||
      (sortedDistinctPaths(paths) &&
        sortedDistinctPaths(deleted) &&
        new Set([...paths, ...deleted]).size === paths.length + deleted.length)) &&
    (!input.producer || isDeepStrictEqual(source.producer, input.producer)) &&
    isDeepStrictEqual(
      source.files.map((file) => ({ ...file.file, target_path: file.target_path })),
      input.files
    )
  )
}

export function sessionOutcomeCurrentWorkspaceMatches(
  source: CurrentSource,
  node: ConsoleWorkflowGraph['nodes'][number]
): boolean {
  const workspace = source.workspace
  if (!workspace) {
    return !source.git
  }
  if (workspace.host !== 'local' || node.placement !== 'local') {
    return false
  }
  if (workspace.kind === 'folder') {
    return !source.git && isDeepStrictEqual(node.workspace, workspace)
  }
  const repo = consoleJobRepositoryIdentity(workspace.repo)
  const role = node.loop_stage?.role
  const overlay =
    role === 'producer' ||
    (source.mode === 'review-source' &&
      node.loop_stage?.round === 1 &&
      (role === 'participant' || role === 'repair'))
  return (
    !!source.git &&
    /^[a-f0-9]{40}$/.test(source.git.head_sha) &&
    source.git.head_sha === workspace.base_sha &&
    !!repo &&
    typeof node.repo === 'string' &&
    consoleJobRepositoryIdentity(node.repo) === repo &&
    node.base_branch === workspace.base_branch &&
    node.base_sha === workspace.base_sha &&
    node.source_overlay === overlay &&
    !node.workspace
  )
}

export function assertSessionOutcomeFolderLoopContract(
  graph: ConsoleWorkflowGraph,
  stage: ConsoleWorkflowStep,
  input: SessionOutcomeCurrentInput
): void {
  if (!stage.loop) {
    return
  }
  const peers = graph.nodes.filter((node) => node.loop_stage?.stage_key === stage.key)
  const source = peers[0]?.current_source
  const rounds = stage.loop.max_rounds
  const recapture = Boolean(input.git) || input.mode === 'base' || rounds > 1
  const expected = new Set<string>()
  for (let round = 1; round <= rounds; round++) {
    expected.add(`participant:${round}`)
    expected.add(`decide:${round}`)
    if (round < rounds) {
      expected.add(`repair:${round}`)
    }
  }
  if (input.mode === 'base') {
    expected.add('producer:0')
  }
  const roles = new Set(
    peers.map((node) => `${String(node.loop_stage?.role)}:${String(node.loop_stage?.round)}`)
  )
  if (
    !source ||
    !Number.isInteger(rounds) ||
    rounds < 1 ||
    rounds > 5 ||
    !isDeepStrictEqual(roles, expected) ||
    !sessionOutcomeCurrentInputMatches(source, input) ||
    peers.some((node) => !isDeepStrictEqual(node.current_source, source))
  ) {
    throw new Error(
      'The snapshot loop must preserve every selected input, producer, repair and bounded decision.'
    )
  }
  for (const node of peers) {
    const role = node.loop_stage?.role
    if (role === 'decide') {
      if (
        node.actor_type !== 'mechanical' ||
        node.mechanical_execution?.input.max_rounds !== rounds
      ) {
        throw new Error('The snapshot loop changed its canonical bounded decision.')
      }
      continue
    }
    const artifact = (node as unknown as Record<string, unknown>).artifact_result
    const path = recapture
      ? role === 'participant'
        ? 'folder-review.json'
        : 'folder-snapshot.json'
      : 'work-result.json'
    if (
      node.actor_type !== 'ai' ||
      !sessionOutcomeCurrentWorkspaceMatches(source, node) ||
      (!source.workspace && node.workspace?.kind !== 'folder') ||
      node.placement !== 'local' ||
      !isDeepStrictEqual(node.source_files, source.files) ||
      !isDeepStrictEqual(node.source_deletions ?? [], source.git?.deleted_paths ?? []) ||
      !isDeepStrictEqual(artifact, { path, format: 'json', max_bytes: 65536 }) ||
      node.action !== (role === 'participant' ? 'review' : role === 'repair' ? 'repair' : 'execute')
    ) {
      throw new Error(
        'The snapshot loop requires its exact snapshot/review artifact consumer contract.'
      )
    }
  }
}
