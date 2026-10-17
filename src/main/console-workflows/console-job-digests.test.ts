import { describe, expect, it } from 'vitest'
import { consoleJobClaimFixture } from '../runtime/orchestration/console-job-test-fixture'
import type { ConsoleLocalJob } from './console-local-execution-contract'
import { consoleJobInputDigest } from './console-job-digests'
import { consoleResultReceiptFingerprint } from '../backoffice/console-workflow-result-publication'

describe('Lane 2 canonical digest compatibility', () => {
  it('matches the executed Python input digest including the exact acceptance argv', () => {
    const job: ConsoleLocalJob = {
      id: 'job_digest1234',
      taskId: 'btk_journal',
      workflowId: 'wf_digest',
      digest: 'a'.repeat(64),
      state: 'running',
      placement: 'local',
      provider: 'claude',
      model: 'model-test',
      title: 'Digest fixture',
      repo: 'team/project',
      baseBranch: 'main',
      prompt: 'Prompt',
      brief: 'A frozen brief 😀',
      acceptance: 'Pass exactly.',
      acceptanceCommands: [{ program: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 1000 }],
      inputs: [],
      ownedPaths: ['src/**'],
      readOnly: false
    }
    expect(consoleJobInputDigest(consoleJobClaimFixture, job, 'b'.repeat(40))).toBe(
      'c9f00bfc8573f5dc2f84e4c862df985a7ff5783769ea12f484d92aaf21c11800'
    )
    expect(
      consoleJobInputDigest(
        consoleJobClaimFixture,
        { ...job, acceptanceCommands: [] },
        'b'.repeat(40)
      )
    ).not.toBe(consoleJobInputDigest(consoleJobClaimFixture, job, 'b'.repeat(40)))
  })
  it('matches Python ASCII receipt serialization for Unicode and control characters', () => {
    expect(
      consoleResultReceiptFingerprint(
        {
          status: 'done',
          output_tail: 'héllo 😀 \u007f',
          changed_files: ['src/\ue000.ts', 'src/😀.ts'],
          attempt: 1,
          claimed_at: '2026-09-08T00:00:00.123456+00:00',
          pr_url: null,
          pr_number: null,
          branch: null
        },
        'local:emp_sal'
      )
    ).toBe('7b6e3f0065425d14680152d126d58cf0046852efe9da642350cb104b15e3f3be')
  })
})
