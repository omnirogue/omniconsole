import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertConsoleGitSnapshotIsolated,
  consoleCurrentGitSource
} from './console-current-git-source'
import { canonicalDigestJson } from './console-job-digests'
import type { ConsoleLocalJob } from './console-local-execution-contract'

const headSha = 'a'.repeat(40)
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

function fixture(
  mode: 'base' | 'review-source' = 'review-source',
  deletionOnly = false,
  role: 'producer' | 'participant' | 'repair' = 'participant'
) {
  const source = {
    schema_version: 1 as const,
    kind: 'current_task_files' as const,
    mode,
    stage_key: 'review',
    root_task_id: 'btk_source1234',
    snapshot_digest: '',
    producer: { provider: 'codex', model: 'model-fixture' },
    workspace: {
      kind: 'git' as const,
      path: join(tmpdir(), 'console-current-source'),
      host: 'local' as const,
      repo: 'https://github.com/team/project.git',
      base_branch: 'feature/captured',
      base_sha: headSha
    },
    git: { head_sha: headSha, deleted_paths: ['src/removed.ts'] },
    files: deletionOnly
      ? []
      : [
          {
            kind: 'task_file' as const,
            task_id: 'btk_source1234',
            file: {
              rel: 'uploads/selected.ts',
              name: 'selected.ts',
              sha256: sha('selected bytes\n'),
              size_bytes: Buffer.byteLength('selected bytes\n')
            },
            target_path: 'src/selected.ts'
          }
        ]
  }
  const input: {
    current_source: typeof source
    source_files: typeof source.files
    source_deletions: string[]
    source_overlay?: boolean
    loop_stage?: { key: string; role: string; round: number }
    folder_candidate?: unknown
  } = {
    current_source: source,
    source_files: structuredClone(source.files),
    source_deletions: [...source.git.deleted_paths],
    source_overlay: true,
    loop_stage: { key: 'review', role, round: role === 'producer' ? 0 : 1 }
  }
  const job: ConsoleLocalJob = {
    id: 'job_current1234',
    taskId: 'btk_review1234',
    workflowId: 'wf_current1234',
    digest: 'b'.repeat(64),
    state: 'running',
    placement: 'local',
    provider: 'codex',
    model: 'model-fixture',
    title: 'Review captured Git files',
    repo: 'team/project',
    baseSha: headSha,
    baseBranch: source.workspace.base_branch,
    prompt: 'Review the selected files.',
    brief: 'Review the current session.',
    acceptance: 'Publish review findings.',
    acceptanceCommands: [],
    artifactResult: {
      path: role === 'participant' ? 'folder-review.json' : 'folder-snapshot.json',
      format: 'json',
      maxBytes: 65536
    },
    inputs: [input],
    ownedPaths: null,
    readOnly: role === 'participant',
    action: role === 'participant' ? 'review' : role === 'repair' ? 'repair' : 'execute'
  }
  const refreshDigest = () => {
    source.snapshot_digest = sha(
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
  }
  refreshDigest()
  return { job, input, source, refreshDigest }
}

type Fixture = ReturnType<typeof fixture>

describe('current Git source contract', () => {
  it('leaves ordinary jobs and folder workspaces to their existing execution paths', () => {
    const { job } = fixture()
    job.inputs = [{ brief: 'ordinary Git job' }, null, 'unrelated']
    expect(consoleCurrentGitSource(job)).toBeNull()
    job.workspace = { kind: 'folder', path: join(tmpdir(), 'folder-source') }
    job.inputs = [{ current_source: { snapshot_digest: 'folder-specific-capture' } }]
    expect(consoleCurrentGitSource(job)).toBeNull()
  })

  it.each(['participant', 'repair'] as const)(
    'accepts the captured files for first-round %s',
    (role) => {
      const { job, input, source } = fixture('review-source', false, role)
      const current = consoleCurrentGitSource(job)
      expect(current).toMatchObject({ source, requiresCandidate: false })
      expect(current?.paths).toEqual(['src/removed.ts', 'src/selected.ts'])
      expect(current?.input).toBe(input)
    }
  )

  it.each([false, undefined])(
    'rejects an initial capture without source_overlay=true (%s)',
    (overlay) => {
      const { job, input, source } = fixture()
      input.source_overlay = overlay
      expect(() => consoleCurrentGitSource(job)).toThrow()
      delete input.loop_stage
      source.mode = 'base'
      job.artifactResult!.path = 'work-result.json'
      expect(() => consoleCurrentGitSource(job)).toThrow()
    }
  )

  it('accepts a base producer capture before any repaired candidate exists', () => {
    const { job } = fixture('base', false, 'producer')
    expect(consoleCurrentGitSource(job)?.requiresCandidate).toBe(false)
  })

  it.each(['participant', 'repair'] as const)(
    'requires a candidate in round two for %s',
    (role) => {
      const { job, input, source } = fixture('review-source', false, role)
      input.loop_stage = { key: 'review', role, round: 2 }
      input.source_overlay = false
      expect(() => consoleCurrentGitSource(job)).toThrow()
      input.folder_candidate = { schema_version: 1, snapshot_digest: 'c'.repeat(64) }
      const captured = structuredClone(source)
      const current = consoleCurrentGitSource(job)
      expect(current?.requiresCandidate).toBe(true)
      expect(current?.source).toEqual(captured)
      expect(input.current_source).toEqual(captured)
    }
  )

  it('requires a producer candidate for the first review of base-mode work', () => {
    const { job, input } = fixture('base')
    expect(() => consoleCurrentGitSource(job)).toThrow()
    input.source_overlay = false
    input.folder_candidate = { schema_version: 1 }
    expect(consoleCurrentGitSource(job)?.requiresCandidate).toBe(true)
  })

  it.each([true, undefined])(
    'rejects a candidate round without source_overlay=false (%s)',
    (overlay) => {
      const { job, input } = fixture()
      input.loop_stage!.round = 2
      input.folder_candidate = { schema_version: 1 }
      input.source_overlay = overlay
      expect(() => consoleCurrentGitSource(job)).toThrow()
    }
  )

  it('refuses a substituted candidate in the initial captured-source review', () => {
    const { job, input } = fixture()
    input.folder_candidate = { schema_version: 1 }
    expect(() => consoleCurrentGitSource(job)).toThrow()
  })

  it.each([0, -1, 1.5, Number.NaN, 6])('rejects invalid reviewer round %s', (round) => {
    const { job, input } = fixture()
    input.loop_stage!.round = round
    expect(() => consoleCurrentGitSource(job)).toThrow()
  })

  it.each([1, 2])('rejects producer round %s after the initial base capture', (round) => {
    const { job, input } = fixture('base', false, 'producer')
    input.loop_stage!.round = round
    expect(() => consoleCurrentGitSource(job)).toThrow()
  })

  it('accepts a standalone base capture with its work-result artifact', () => {
    const { job, input } = fixture('base', false, 'producer')
    delete input.loop_stage
    job.artifactResult!.path = 'work-result.json'
    expect(consoleCurrentGitSource(job)?.requiresCandidate).toBe(false)
  })

  it('accepts a deletion-only capture and retains its exact removal set', () => {
    const { job, source } = fixture('review-source', true)
    expect(consoleCurrentGitSource(job)).toMatchObject({
      source,
      paths: ['src/removed.ts'],
      requiresCandidate: false
    })
  })

  it.each<[string, (value: Fixture) => void]>([
    [
      'execution placement',
      ({ job }) => {
        job.placement = 'fleet'
      }
    ],
    [
      'source host',
      ({ source }) => {
        Object.assign(source.workspace, { host: 'ssh:remote' })
      }
    ],
    [
      'relative source root',
      ({ source }) => {
        source.workspace.path = 'relative/repository'
      }
    ],
    [
      'unnormalized root',
      ({ source }) => {
        source.workspace.path += '/child/..'
      }
    ],
    [
      'source root NUL',
      ({ source }) => {
        source.workspace.path += '\0'
      }
    ],
    [
      'repository',
      ({ job }) => {
        job.repo = 'other/project'
      }
    ],
    [
      'repository host',
      ({ job }) => {
        job.repo = 'https://gitlab.com/team/project'
      }
    ],
    [
      'missing repository',
      ({ job }) => {
        job.repo = null
      }
    ],
    [
      'branch',
      ({ job }) => {
        job.baseBranch = 'main'
      }
    ],
    [
      'base SHA',
      ({ job }) => {
        job.baseSha = 'd'.repeat(40)
      }
    ],
    [
      'source base SHA',
      ({ source }) => {
        source.workspace.base_sha = 'd'.repeat(40)
      }
    ],
    [
      'short HEAD',
      ({ source }) => {
        source.git.head_sha = headSha.slice(0, 12)
      }
    ],
    [
      'uppercase HEAD',
      ({ source }) => {
        source.git.head_sha = headSha.toUpperCase()
      }
    ],
    [
      'missing result contract',
      ({ job }) => {
        delete job.artifactResult
      }
    ],
    [
      'result artifact kind',
      ({ job }) => {
        job.artifactResult!.path = 'folder-snapshot.json'
      }
    ],
    [
      'role action',
      ({ job }) => {
        job.action = 'repair'
      }
    ],
    [
      'read-only review flag',
      ({ job }) => {
        job.readOnly = false
      }
    ],
    [
      'acceptance command',
      ({ job }) => {
        job.acceptanceCommands = [{ program: 'node', args: ['check.js'], timeoutMs: 1000 }]
      }
    ],
    [
      'mutable revision',
      ({ job }) => {
        job.revision = {
          confirmed: true,
          branch: 'main',
          reviewUrl: 'https://github.com/team/project/pull/1',
          reviewNumber: 1
        }
      }
    ],
    [
      'selected upload metadata',
      ({ input }) => {
        input.source_files[0].file.rel = 'uploads/other.ts'
      }
    ],
    [
      'selected task identity',
      ({ input }) => {
        input.source_files[0].task_id = 'btk_other1234'
      }
    ],
    [
      'capture task identity',
      ({ input, source }) => {
        source.files[0].task_id = 'btk_other1234'
        input.source_files = structuredClone(source.files)
      }
    ],
    [
      'selected file content',
      ({ input }) => {
        input.source_files[0].file.sha256 = 'd'.repeat(64)
      }
    ],
    [
      'selected file target',
      ({ input }) => {
        input.source_files[0].target_path = 'src/other.ts'
      }
    ],
    [
      'deletion selection',
      ({ input }) => {
        input.source_deletions = ['src/other.ts']
      }
    ],
    [
      'snapshot digest',
      ({ source }) => {
        source.snapshot_digest = 'd'.repeat(64)
      }
    ],
    [
      'loop role',
      ({ input }) => {
        input.loop_stage!.role = 'unrecognized'
      }
    ]
  ])('rejects changed %s', (_name, mutate) => {
    const value = fixture()
    mutate(value)
    expect(() => consoleCurrentGitSource(value.job)).toThrow()
  })

  it.each(['head', 'bytes', 'size', 'target', 'deletions'])(
    'rejects synchronized %s metadata changes without the captured digest',
    (field) => {
      const { job, input, source } = fixture()
      if (field === 'head') {
        job.baseSha = source.workspace.base_sha = source.git.head_sha = 'd'.repeat(40)
      } else if (field === 'bytes') {
        source.files[0].file.sha256 = 'd'.repeat(64)
      } else if (field === 'size') {
        source.files[0].file.size_bytes++
      } else if (field === 'target') {
        source.files[0].target_path = 'src/other.ts'
      } else {
        source.git.deleted_paths = ['src/other.ts']
      }
      input.source_files = structuredClone(source.files)
      input.source_deletions = [...source.git.deleted_paths]
      expect(() => consoleCurrentGitSource(job)).toThrow()
    }
  )

  it.each(['duplicate', 'case-collision', 'ancestor', 'unsorted'] as const)(
    'rejects %s paths even with a matching digest',
    (kind) => {
      const { job, input, source, refreshDigest } = fixture()
      source.git.deleted_paths = {
        duplicate: ['src/selected.ts'],
        'case-collision': ['src/SELECTED.ts'],
        ancestor: ['src'],
        unsorted: ['z.ts', 'a.ts']
      }[kind]!
      input.source_deletions = [...source.git.deleted_paths]
      refreshDigest()
      expect(() => consoleCurrentGitSource(job)).toThrow()
    }
  )

  it.each(['../outside.ts', '.git/config', 'src\\selected.ts'])(
    'rejects unsafe selected path %s',
    (target) => {
      const { job, input, source, refreshDigest } = fixture()
      source.files[0].target_path = target
      input.source_files = structuredClone(source.files)
      refreshDigest()
      expect(() => consoleCurrentGitSource(job)).toThrow()
    }
  )

  it('rejects file selections out of capture order even when their digest matches', () => {
    const { job, input, source, refreshDigest } = fixture()
    source.files.push({ ...structuredClone(source.files[0]), target_path: 'a.ts' })
    input.source_files = structuredClone(source.files)
    refreshDigest()
    expect(() => consoleCurrentGitSource(job)).toThrow()
  })

  it('matches equivalent repository URLs while keeping the captured branch and SHA', () => {
    const { job } = fixture()
    job.repo = 'git@github.com:team/project.git'
    expect(consoleCurrentGitSource(job)?.git.head_sha).toBe(headSha)
  })
})

describe('current Git snapshot isolation', () => {
  it('refuses the source session directory, including equivalent normalized paths', () => {
    const { job, source } = fixture()
    expect(() => assertConsoleGitSnapshotIsolated(job, source.workspace.path)).toThrow(/isolated/)
    expect(() =>
      assertConsoleGitSnapshotIsolated(job, `${source.workspace.path}/child/..`)
    ).toThrow(/isolated/)
    expect(() =>
      assertConsoleGitSnapshotIsolated(job, `${source.workspace.path}-review`)
    ).not.toThrow()
  })

  it('does not impose a captured-source root on an ordinary Git job', () => {
    const { job, source } = fixture()
    job.inputs = []
    expect(() => assertConsoleGitSnapshotIsolated(job, source.workspace.path)).not.toThrow()
  })
})
