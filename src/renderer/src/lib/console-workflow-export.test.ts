import { describe, expect, it } from 'vitest'
import { workflowJobFixture } from '../components/console-workflows/console-workflow-test-fixtures'
import { exportConsoleWorkflowView } from './console-workflow-export'

describe('authoritative current workflow view export', () => {
  const build = workflowJobFixture()
  const review = workflowJobFixture({
    id: 'job_review',
    title: 'Review "quote" <script>',
    workflow_state: 'skipped',
    policy: {
      workflow: {
        ...build.policy.workflow,
        key: 'review',
        after: [build.id],
        require_merged: [build.id],
        placement: 'fleet'
      }
    }
  })

  it('exports the received JSON view without a local template or new authority fields', () => {
    const view = { workflow_id: 'wf_test', jobs: [review, build] }
    expect(JSON.parse(exportConsoleWorkflowView(view, 'json'))).toEqual(view)
    expect(view.jobs).toEqual([review, build])
  })

  it('uses stable topology and escapes Mermaid controls while preserving state and placement', () => {
    const result = exportConsoleWorkflowView(
      { workflow_id: 'wf_test', jobs: [review, build] },
      'mermaid'
    )
    expect(result).toBe(
      exportConsoleWorkflowView({ workflow_id: 'wf_test', jobs: [build, review] }, 'mermaid')
    )
    expect(result).toContain('n0 -->|merged| n1')
    expect(result).toContain('skipped')
    expect(result).toContain('fleet')
    expect(result).toContain('#34;quote#34;')
    expect(result).not.toContain('<script>')
  })

  it('refuses an incomplete dependency graph instead of inventing missing stages', () => {
    expect(() =>
      exportConsoleWorkflowView({ workflow_id: 'wf_test', jobs: [review] }, 'mermaid')
    ).toThrow('missing stage')
  })
})
