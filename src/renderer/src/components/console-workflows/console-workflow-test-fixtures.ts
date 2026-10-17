import type {
  ConsoleWorkflowJob,
  ConsoleWorkflowPreview
} from '../../../../shared/console-workflow-types'
import { newWorkflowDraft } from '@/lib/console-workflow-draft'
import type { ConsoleLocalExecutionView } from '../../../../shared/console-local-execution'

export const workflowDigest = 'a'.repeat(64)

export function workflowExecutionFixture(
  overrides: Partial<ConsoleLocalExecutionView> = {}
): ConsoleLocalExecutionView {
  return {
    jobId: 'job_build',
    workflowId: 'wf_test',
    cardId: 'btk_test1234',
    runId: 'run_test',
    dispatchId: 'dispatch_test',
    terminalHandle: 'term_test',
    worktreeId: 'folder:folder-1',
    branch: 'feature',
    state: 'running',
    ...overrides
  }
}

export function workflowJobFixture(
  overrides: Partial<ConsoleWorkflowJob> = {}
): ConsoleWorkflowJob {
  return {
    id: 'job_build',
    task_id: 'btk_test1234',
    node_id: 'btk_test1234',
    title: 'Build search',
    status: 'queued',
    actor_type: 'ai',
    provider: 'codex',
    model: 'test-model',
    effort: 'high',
    repo: null,
    machine: null,
    pr_url: null,
    attempt: 1,
    lease_generation: 1,
    owned_paths: ['src/**'],
    updated_at: '2026-09-08T12:00:00Z',
    policy: {
      workflow: {
        version: 1,
        digest: workflowDigest,
        mode: 'hybrid',
        dispatch_id: 'wf_test',
        key: 'build',
        actor_type: 'ai',
        actor_id: 'codex',
        action: 'execute',
        after: [],
        after_keys: [],
        require_merged: [],
        approval_ancestors: []
      }
    },
    blockers: [],
    workflow_state: 'queued',
    can_decide: false,
    ...overrides
  }
}

export function workflowPreviewFixture(): ConsoleWorkflowPreview {
  return {
    workflow_id: 'wf_test',
    digest: workflowDigest,
    jobs: [],
    graph: {
      schema_version: 1,
      mode: 'sequential',
      title: 'Search workflow',
      prompt: '  Exact workflow prompt\n',
      company: 'omni',
      owner: 'emp_sal',
      policy: {},
      nodes: [
        {
          key: 'build',
          title: 'Build search',
          brief: '  Exact stage prompt\n',
          actor_type: 'ai',
          actor_id: 'codex',
          action: 'execute',
          after: [],
          owned_paths: ['src/**'],
          provider: 'codex',
          model: 'test-model',
          effort: 'high',
          placement: 'local',
          acceptance_commands: []
        }
      ],
      columns: [['build']],
      dispatch_id: 'wf_test',
      digest: workflowDigest
    }
  }
}

export function workflowDraftFixture() {
  const draft = newWorkflowDraft('btk_test1234')
  return {
    ...draft,
    title: 'Search workflow',
    company: 'omni',
    repo: 'Example/project',
    prompt: '  Exact workflow prompt\n',
    admission: {
      goalId: 'cgl_existing',
      title: 'Search objective',
      desiredResult: 'Search shipped',
      acceptancePolicy: '{"required":["all_selected_nodes_verified"]}',
      verificationPolicy: '{"schema_version":1}',
      orgUnitId: 'ou_dev',
      authorityEpoch: '3',
      adoptStage: 'build'
    },
    stages: [
      {
        ...draft.stages[0],
        key: 'build',
        title: 'Build search',
        provider: 'codex',
        model: 'test-model',
        effort: 'high',
        prompt: '  Exact stage prompt\n'
      }
    ]
  }
}
