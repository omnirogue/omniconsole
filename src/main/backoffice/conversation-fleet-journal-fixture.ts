import type { ConversationFleetReceipt } from '../../shared/conversation-fleet-receipt'
import type { ConsoleWorkflowJob } from '../../shared/console-workflow-types'

export function pendingReceipt(): ConversationFleetReceipt {
  return {
    workflowId: 'wf_dispatch',
    taskId: 'btk_test1234',
    rowKey: 'ssh:source/session',
    sessionKey: 'session',
    title: 'Review',
    createdAt: '2026-09-16T00:00:00.000Z',
    machine: 'mw0002',
    digest: 'a'.repeat(64),
    admission: 'pending',
    intent: {
      operationId: 'operation-one',
      source: {
        sourceHostId: 'ssh:source',
        sourceSessionId: 'provider-session',
        sourceWorkspacePath: '/folder',
        sourceRuntimeEnvironmentId: 'runtime-source',
        sourceTurnId: 'turn-one',
        sourceRuntimeFence: 42,
        transcript: 'Exact readable transcript',
        sourceRawTranscript: '{"role":"user","content":"Review"}',
        sourceAgent: 'omp',
        sourceKind: 'provider',
        sourceRawFormat: 'provider-jsonl'
      },
      request: {
        taskId: 'btk_test1234',
        expectedRevision: 7,
        digest: 'a'.repeat(64),
        contextDigest: 'b'.repeat(64),
        adoptStage: 'review',
        graph: {
          schema_version: 1,
          mode: 'single_shot',
          title: 'Review',
          prompt: 'Review',
          company: 'omni',
          owner: 'emp_sal',
          policy: {},
          columns: [['review']],
          dispatch_id: 'wf_dispatch',
          digest: 'a'.repeat(64),
          nodes: [
            {
              key: 'review',
              title: 'Review',
              brief: 'Review exact source',
              actor_type: 'ai',
              actor_id: 'omp:openrouter/model',
              provider: 'omp',
              model: 'openrouter/model',
              action: 'execute',
              after: [],
              owned_paths: null,
              placement: 'fleet',
              source_files: [
                {
                  kind: 'task_file',
                  task_id: 'btk_test1234',
                  target_path: 'src/search.ts',
                  file: {
                    rel: 'files/search.ts',
                    name: 'search.ts',
                    sha256: 'c'.repeat(64),
                    size_bytes: 27
                  }
                }
              ]
            }
          ]
        }
      }
    }
  }
}

export function progressJob(status = 'running'): ConsoleWorkflowJob {
  return {
    id: 'job_review',
    task_id: 'btk_test1234',
    status,
    can_decide: false,
    policy: {
      workflow: {
        key: 'review',
        digest: 'a'.repeat(64),
        dispatch_id: 'wf_dispatch',
        source_task_id: 'btk_test1234',
        source: { session_ref: 'ssh:source/session', session_id: 'session' }
      }
    }
  } as unknown as ConsoleWorkflowJob
}
