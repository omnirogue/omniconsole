import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { canonicalDigestJson } from '../console-workflows/console-job-digests'
import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
import { folderRoundFixture } from './session-outcome-workflow-folder-round-fixture'
import { closedSessionOutcomeStages } from './session-outcome-workflow-projection'
import type { ConsoleWorkflowGraph } from '../../shared/console-workflow-types'
function fixture() {
  const f = workflowProofFixture()
  const file = {
    rel: 'uploads/report.txt',
    name: 'report.txt',
    sha256: 'f'.repeat(64),
    size_bytes: 14,
    target_path: 'docs/report.txt'
  }
  const snapshotDigest = createHash('sha256')
    .update(
      canonicalDigestJson([
        { target_path: file.target_path, sha256: file.sha256, size_bytes: file.size_bytes }
      ])
    )
    .digest('hex')
  const { target_path, ...pin } = file
  const source = {
    schema_version: 1 as const,
    kind: 'current_task_files' as const,
    mode: 'review-source' as const,
    stage_key: 'build',
    root_task_id: 'btk_root',
    files: [{ kind: 'task_file' as const, task_id: 'btk_root', file: pin, target_path }],
    snapshot_digest: snapshotDigest,
    producer: { provider: 'codex', model: 'gpt-5.6-terra' }
  }
  f.workflow.preview.graph.nodes = f.workflow.preview.graph.nodes
    .slice(1)
    .map((node) => ({ ...node, current_source: structuredClone(source) }))
  f.workflow.currentInputs = [{ stage_key: 'build', mode: 'review-source', files: [file] }]
  f.workflow.receipts = f.workflow.receipts!.slice(1).map((receipt) => ({
    ...receipt,
    candidateSha: null,
    branch: null,
    prUrl: null,
    inputDigest: 'e'.repeat(64),
    verdict: { ...receipt.verdict!, notes: `Reviewed ${snapshotDigest}` }
  }))
  return {
    ...f,
    jobs: f.jobs.slice(1).map((job) => ({
      ...job,
      policy: {
        ...job.policy,
        workflow: { ...job.policy.workflow, current_source: structuredClone(source) }
      }
    }))
  }
}
it('closes current-folder review only from exact frozen files and actual claim-bound review receipts without a Git SHA', () => {
  const { workflow, jobs } = fixture()
  expect(closedSessionOutcomeStages(workflow, jobs)).toMatchObject([
    { key: 'build', round: 1, reviews: [{ candidateSha: null }, { candidateSha: null }] }
  ])
})
it.each([
  'input-digest',
  'snapshot',
  'member-snapshot',
  'retained-files',
  'notes',
  'git-candidate',
  'round'
] as const)('refuses changed current-folder %s proof', (kind) => {
  const { workflow, jobs } = fixture()
  const decider = workflow.preview.graph.nodes.at(-1)!
  if (kind === 'input-digest') {
    delete workflow.receipts![0]!.inputDigest
  }
  if (kind === 'snapshot') {
    decider.current_source!.snapshot_digest = '0'.repeat(64)
  }
  if (kind === 'member-snapshot') {
    workflow.preview.graph.nodes[0]!.current_source!.files[0]!.file.sha256 = '0'.repeat(64)
  }
  if (kind === 'retained-files') {
    workflow.currentInputs![0]!.files[0]!.target_path = 'different.txt'
  }
  if (kind === 'notes') {
    workflow.receipts![0]!.verdict!.notes = 'Only prose'
  }
  if (kind === 'git-candidate') {
    workflow.receipts![0]!.candidateSha = 'a'.repeat(40)
  }
  if (kind === 'round') {
    decider.mechanical_execution!.input.max_rounds = 2
  }
  expect(closedSessionOutcomeStages(workflow, jobs)).toEqual([])
})

type CurrentSource = NonNullable<ConsoleWorkflowGraph['nodes'][number]['current_source']>
function initialDigest(source: CurrentSource, includeGit = true): string {
  const files = source.files
    .map(({ file, target_path }) => ({
      target_path,
      sha256: file.sha256,
      size_bytes: file.size_bytes
    }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.target_path), Buffer.from(b.target_path)))
  return createHash('sha256')
    .update(
      canonicalDigestJson(
        includeGit && source.git
          ? {
              head_sha: source.git.head_sha,
              files,
              deleted_paths: [...source.git.deleted_paths].sort((a, b) =>
                Buffer.compare(Buffer.from(a), Buffer.from(b))
              )
            }
          : files
      )
    )
    .digest('hex')
}
function gitFixture(
  rounds: 1 | 2 = 1,
  deletionOnly = false,
  mode: 'base' | 'review-source' = 'review-source'
) {
  const f = rounds === 1 ? fixture() : folderRoundFixture(mode)
  const source = structuredClone(f.workflow.preview.graph.nodes[0]!.current_source!)
  source.git = {
    head_sha: 'a'.repeat(40),
    deleted_paths: ['docs/a-deleted.txt', 'docs/z-deleted.txt']
  }
  source.workspace = {
    kind: 'git',
    host: 'local',
    path: '/workspace/review',
    repo: 'https://gitlab.example/Team/Project.git',
    base_branch: 'main',
    base_sha: source.git.head_sha
  }
  if (deletionOnly) {
    source.files = []
  }
  source.snapshot_digest = initialDigest(source)
  for (const node of f.workflow.preview.graph.nodes) {
    Object.assign(node, {
      current_source: structuredClone(source),
      repo: 'git@gitlab.example:team/project.git',
      base_branch: source.workspace.base_branch,
      base_sha: source.workspace.base_sha,
      source_files: structuredClone(source.files),
      source_deletions: [...source.git.deleted_paths],
      source_overlay:
        node.loop_stage?.role === 'producer' ||
        (source.mode === 'review-source' && node.loop_stage?.round === 1)
    })
    delete node.workspace
    if (node.loop_stage?.role === 'participant') {
      Object.assign(node, {
        artifact_result: { path: 'folder-review.json', format: 'json', max_bytes: 65536 }
      })
    }
  }
  for (const job of f.jobs) {
    job.policy.workflow.current_source = structuredClone(source)
  }
  f.workflow.currentInputs = [
    {
      stage_key: source.stage_key,
      mode: source.mode,
      git: structuredClone(source.git),
      files: source.files.map(({ file, target_path }) => ({ ...file, target_path }))
    }
  ]
  for (const [index, receipt] of f.workflow.receipts!.entries()) {
    if (receipt.verdict) {
      receipt.verdict.notes = `Reviewed ${source.snapshot_digest}`
    }
    if (rounds === 1) {
      receipt.eventId = 100 + index * 2
      receipt.folderArtifact = {
        resultEventId: receipt.eventId - 1,
        fileId: `tfl_gitreview${index}`,
        sha256: 'd'.repeat(64),
        reviewedSnapshot: {
          schema_version: 1,
          kind: 'current_task_files',
          snapshot_digest: source.snapshot_digest
        }
      }
    }
    const reviewed = receipt.folderArtifact?.reviewedSnapshot
    if (reviewed?.kind === 'current_task_files') {
      reviewed.snapshot_digest = source.snapshot_digest
    }
  }
  return { ...f, source }
}
function replaceSource(f: ReturnType<typeof gitFixture>): void {
  for (const node of f.workflow.preview.graph.nodes) {
    node.current_source = structuredClone(f.source)
    node.source_files = structuredClone(f.source.files)
    node.source_deletions = [...(f.source.git?.deleted_paths ?? [])]
  }
  for (const job of f.jobs) {
    job.policy.workflow.current_source = structuredClone(f.source)
  }
  for (const receipt of f.workflow.receipts!) {
    const reviewed = receipt.folderArtifact?.reviewedSnapshot
    if (reviewed?.kind === 'current_task_files') {
      reviewed.snapshot_digest = f.source.snapshot_digest
    }
  }
}
it.each([false, true])(
  'accepts the exact initial Git snapshot, including deletion-only selection=%s',
  (deletionOnly) => {
    const f = gitFixture(1, deletionOnly)
    expect(f.source.snapshot_digest).not.toBe(initialDigest(f.source, false))
    expect(closedSessionOutcomeStages(f.workflow, f.jobs)).toMatchObject([
      { key: 'build', round: 1, reviews: [{ candidateSha: null }, { candidateSha: null }] }
    ])
  }
)
it.each([
  'file-only-digest',
  'missing-git',
  'retained-head',
  'retained-deletions',
  'missing-workspace',
  'head-base-mismatch',
  'remote-workspace',
  'repo-host',
  'base-branch',
  'base-sha',
  'node-workspace',
  'fleet',
  'notes-only',
  'old-consumer',
  'candidate',
  'pr',
  'branch'
] as const)('refuses changed initial Git %s proof', (mutation) => {
  const f = gitFixture()
  const node = f.workflow.preview.graph.nodes[0]!
  if (mutation === 'file-only-digest') {
    f.source.snapshot_digest = initialDigest(f.source, false)
  }
  if (mutation === 'missing-git') {
    delete f.workflow.currentInputs![0]!.git
  }
  if (mutation === 'retained-head') {
    f.workflow.currentInputs![0]!.git!.head_sha = 'b'.repeat(40)
  }
  if (mutation === 'retained-deletions') {
    f.workflow.currentInputs![0]!.git!.deleted_paths.pop()
  }
  if (mutation === 'missing-workspace') {
    delete f.source.workspace
  }
  if (mutation === 'head-base-mismatch') {
    Object.assign(f.source.workspace!, { base_sha: 'b'.repeat(40) })
  }
  if (mutation === 'remote-workspace') {
    Object.assign(f.source.workspace!, { host: 'remote-host' })
  }
  if (mutation === 'repo-host') {
    node.repo = 'https://github.com/Team/Project.git'
  }
  if (mutation === 'base-branch') {
    node.base_branch = 'other'
  }
  if (mutation === 'base-sha') {
    node.base_sha = 'b'.repeat(40)
  }
  if (mutation === 'node-workspace') {
    node.workspace = { kind: 'folder', host: 'local', path: '/workspace/review' }
  }
  if (mutation === 'fleet') {
    node.placement = 'fleet'
  }
  if (mutation === 'notes-only') {
    delete f.workflow.receipts![0]!.folderArtifact
  }
  if (mutation === 'old-consumer') {
    Object.assign(node, {
      artifact_result: { path: 'work-result.json', format: 'json', max_bytes: 65536 }
    })
  }
  if (mutation === 'candidate') {
    f.workflow.receipts![0]!.candidateSha = 'b'.repeat(40)
  }
  if (mutation === 'pr') {
    f.workflow.receipts![0]!.prUrl = 'https://gitlab.example/Team/Project/-/merge_requests/1'
  }
  if (mutation === 'branch') {
    f.workflow.receipts![0]!.branch = 'candidate-branch'
  }
  replaceSource(f)
  for (const receipt of f.workflow.receipts!) {
    receipt.verdict!.notes = `Reviewed ${f.source.snapshot_digest}`
  }
  expect(closedSessionOutcomeStages(f.workflow, f.jobs)).toEqual([])
})
it.each(['duplicate', 'overlap'] as const)(
  'refuses %s deletion selection even with a matching initial digest',
  (mutation) => {
    const f = gitFixture()
    f.source.git!.deleted_paths.push(
      mutation === 'duplicate' ? f.source.git!.deleted_paths[0]! : f.source.files[0]!.target_path
    )
    f.source.git!.deleted_paths.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    f.source.snapshot_digest = initialDigest(f.source)
    f.workflow.currentInputs![0]!.git = structuredClone(f.source.git)
    replaceSource(f)
    for (const receipt of f.workflow.receipts!) {
      receipt.verdict!.notes = `Reviewed ${f.source.snapshot_digest}`
    }
    expect(closedSessionOutcomeStages(f.workflow, f.jobs)).toEqual([])
  }
)
it.each(['files', 'deletions'] as const)(
  'rejects unsorted Git %s even when retained order and canonical digest match',
  (selection) => {
    const f = gitFixture()
    if (selection === 'files') {
      f.source.files.push({
        ...structuredClone(f.source.files[0]!),
        target_path: 'docs/a-first.txt'
      })
    } else {
      const [first, last] = f.source.git!.deleted_paths
      f.source.git!.deleted_paths = [last!, first!]
    }
    f.source.snapshot_digest = initialDigest(f.source)
    const retained = f.workflow.currentInputs![0]!
    retained.git = structuredClone(f.source.git)
    retained.files = f.source.files.map(({ file, target_path }) => ({ ...file, target_path }))
    replaceSource(f)
    for (const receipt of f.workflow.receipts!) {
      receipt.verdict!.notes = `Reviewed ${f.source.snapshot_digest}`
    }
    expect(closedSessionOutcomeStages(f.workflow, f.jobs)).toEqual([])
  }
)
it.each(['files', 'deletions'] as const)(
  'requires UTF-8 byte order rather than JavaScript string order for Git %s',
  (selection) => {
    const f = gitFixture()
    const paths = ['docs/\uE000.txt', 'docs/\u{10000}.txt']
    if (selection === 'files') {
      f.source.files = paths.map((target_path) => ({
        ...structuredClone(f.source.files[0]!),
        target_path
      }))
    } else {
      f.source.git!.deleted_paths = paths
    }
    f.source.snapshot_digest = initialDigest(f.source)
    const retained = f.workflow.currentInputs![0]!
    retained.git = structuredClone(f.source.git)
    retained.files = f.source.files.map(({ file, target_path }) => ({ ...file, target_path }))
    replaceSource(f)
    expect(closedSessionOutcomeStages(f.workflow, f.jobs)).toMatchObject([
      { key: 'build', round: 1 }
    ])
    if (selection === 'files') {
      f.source.files = [f.source.files[1]!, f.source.files[0]!]
    } else {
      f.source.git!.deleted_paths = [paths[1]!, paths[0]!]
    }
    expect(initialDigest(f.source)).toBe(f.source.snapshot_digest)
    retained.git = structuredClone(f.source.git)
    retained.files = f.source.files.map(({ file, target_path }) => ({ ...file, target_path }))
    replaceSource(f)
    expect(closedSessionOutcomeStages(f.workflow, f.jobs)).toEqual([])
  }
)
function repairSnapshot(f: ReturnType<typeof gitFixture>, paths: string[]): void {
  const repair = f.workflow.receipts!.find((receipt) => receipt.key.includes('repair'))!
  const snapshot = repair.folderArtifact!.folderSnapshot!
  snapshot.manifest = paths.map((path) => ({
    path,
    mode: 0o644,
    sha256: 'c'.repeat(64),
    size_bytes: 14
  }))
  snapshot.snapshot_digest = createHash('sha256')
    .update(
      canonicalDigestJson(
        snapshot.manifest
          .map(({ path, sha256, size_bytes }) => ({ target_path: path, sha256, size_bytes }))
          .sort((a, b) => Buffer.compare(Buffer.from(a.target_path), Buffer.from(b.target_path)))
      )
    )
    .digest('hex')
  const reviews = f.workflow.receipts!.filter((entry) => entry.key.includes('participant_2'))
  for (const receipt of reviews) {
    receipt.folderArtifact!.reviewedSnapshot!.snapshot_digest = snapshot.snapshot_digest
  }
}
it.each([false, true])(
  'accepts later Git snapshots restoring selected deletions, initial deletion-only=%s',
  (deletionOnly) => {
    const f = gitFixture(2, deletionOnly)
    repairSnapshot(f, [f.source.git!.deleted_paths[0]!])
    expect(closedSessionOutcomeStages(f.workflow, f.jobs)).toMatchObject([
      { key: 'build', round: 2 }
    ])
  }
)
it('accepts an empty later Git snapshot after deleting all selected files', () => {
  const f = gitFixture(2)
  repairSnapshot(f, [])
  expect(closedSessionOutcomeStages(f.workflow, f.jobs)).toMatchObject([{ key: 'build', round: 2 }])
})
it.each(['base', 'review-source'] as const)(
  'refuses missing or changed overlays on the %s accepted repair and its reviewers',
  (mode) => {
    const f = gitFixture(2, false, mode)
    expect(closedSessionOutcomeStages(f.workflow, f.jobs)).toMatchObject([
      { key: 'build', round: 2 }
    ])
    const nodes = f.workflow.preview.graph.nodes.filter(
      (node) =>
        node.loop_stage?.role === 'repair' ||
        (node.loop_stage?.role === 'participant' && node.loop_stage?.round === 2)
    )
    for (const node of nodes) {
      const overlay = node.source_overlay
      delete node.source_overlay
      expect(closedSessionOutcomeStages(f.workflow, f.jobs)).toEqual([])
      node.source_overlay = !overlay
      expect(closedSessionOutcomeStages(f.workflow, f.jobs)).toEqual([])
      node.source_overlay = overlay
    }
  }
)
it.each(['job', 'attempt', 'artifact', 'digest', 'outside-selection', 'candidate', 'pr'] as const)(
  'refuses accepted Git repair snapshot with changed %s',
  (mutation) => {
    const f = gitFixture(2)
    const review = f.workflow.receipts!.find((receipt) => receipt.key.includes('participant_2'))!
    const binding = review.folderArtifact!.reviewedSnapshot!
    if (binding.kind !== 'accepted_folder_snapshot') {
      throw new Error('Fixture must review its accepted repair snapshot.')
    }
    if (mutation === 'job') {
      binding.source_job_id = 'job_unrelated000'
    }
    if (mutation === 'attempt') {
      binding.source_attempt++
    }
    if (mutation === 'artifact') {
      binding.artifact_sha256 = '0'.repeat(64)
    }
    if (mutation === 'digest') {
      binding.snapshot_digest = f.source.snapshot_digest
    }
    if (mutation === 'outside-selection') {
      repairSnapshot(f, ['unselected.txt'])
    }
    const repair = f.workflow.receipts!.find((receipt) => receipt.key.includes('repair'))!
    if (mutation === 'candidate') {
      repair.candidateSha = 'b'.repeat(40)
    }
    if (mutation === 'pr') {
      repair.prUrl = 'https://gitlab.example/Team/Project/-/merge_requests/1'
    }
    expect(closedSessionOutcomeStages(f.workflow, f.jobs)).toEqual([])
  }
)
