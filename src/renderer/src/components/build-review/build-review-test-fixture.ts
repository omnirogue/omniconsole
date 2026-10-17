import type { BuildReviewPipelineSnapshot } from '../../../../shared/build-review-pipeline'

export function pipelineFixture(
  overrides: Partial<BuildReviewPipelineSnapshot> = {}
): BuildReviewPipelineSnapshot {
  return {
    id: 'pipeline-1',
    runId: 'run-1',
    worktree: 'id:repo::/workspace',
    worktreeId: 'repo::/workspace',
    objective: 'Build a search dialog',
    reviewFocus: null,
    hubTaskId: null,
    stage: 'reviewing',
    coordinatorTerminalHandle: null,
    builder: {
      role: 'builder',
      choice: { agent: 'codex' },
      status: 'succeeded',
      taskId: 'task-builder',
      dispatchId: null,
      terminalHandle: 'term_builder',
      error: null,
      report: {
        subject: 'Search implemented',
        body: 'Added keyboard navigation.',
        outcome: 'succeeded',
        filesModified: ['src/search.tsx'],
        reportPath: null,
        reportedAt: '2026-09-07T12:00:00Z'
      }
    },
    reviewer: {
      role: 'reviewer',
      choice: { agent: 'claude', model: 'opus', effort: 'high' },
      status: 'running',
      taskId: 'task-reviewer',
      dispatchId: null,
      terminalHandle: 'term_reviewer',
      report: null,
      error: null
    },
    pendingQuestion: {
      messageId: 'message-1',
      role: 'reviewer',
      question: 'Should search include archived items?',
      options: ['Yes', 'No'],
      askedAt: '2026-09-07T12:00:00Z'
    },
    events: [
      {
        at: '2026-09-07T12:00:00Z',
        kind: 'worker_started',
        role: 'reviewer',
        text: 'Review started'
      }
    ],
    error: null,
    createdAt: '2026-09-07T11:00:00Z',
    updatedAt: '2026-09-07T12:00:00Z',
    ...overrides
  }
}
