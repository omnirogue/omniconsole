import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type {
  BuildReviewPipelineSnapshot,
  BuildReviewWorkerSnapshot
} from '../../../shared/build-review-pipeline'
import { REVIEW_FINDINGS_MARKER, type ReviewEvidence } from '../../../shared/review-findings'
import { judgeReviewer } from './build-review-reviewer-judgement'

let workspace = ''
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'review-judgement-'))
  await writeFile(join(workspace, 'package.json'), '{"name":"candidate"}\n')
  await writeFile(join(workspace, 'plan.md'), 'Step 1: deploy on Friday night.\n')
})

const pipeline = { evidenceRequired: true } as BuildReviewPipelineSnapshot
const host = () => ({ workspacePath: workspace, files: ['plan.md'] })

function reviewerReporting(evidence: ReviewEvidence, verdict: string): BuildReviewWorkerSnapshot {
  const findings = { findings: [{ id: 'F1', severity: 'blocker', claim: 'broken', evidence }] }
  return {
    role: 'reviewer',
    choice: { agent: 'codex' },
    status: 'succeeded',
    taskId: null,
    dispatchId: null,
    terminalHandle: null,
    error: null,
    report: {
      subject: 'Review',
      body: `Review.\n${REVIEW_FINDINGS_MARKER} ${JSON.stringify(findings)}\nVERDICT: ${verdict}`,
      outcome: 'succeeded',
      filesModified: [],
      reportPath: null,
      reportedAt: '2026-09-23T12:00:00Z'
    }
  }
}

describe('judgeReviewer', () => {
  it('keeps blocking on an assertion whose failure message is also in its arguments', async () => {
    // A real assertion on the candidate that fails and prints its own custom message.
    const assertion: ReviewEvidence = {
      kind: 'command',
      program: process.execPath,
      args: [
        '-e',
        "require('node:assert').ok(require('./package.json').private, 'must be private')"
      ],
      expect: 'fail',
      output: 'must be private'
    }
    const reviewer = reviewerReporting(assertion, 'REQUEST_CHANGES')
    const judged = await judgeReviewer(pipeline, reviewer, 'REQUEST_CHANGES', host())
    expect(judged.blocks).toBe(true)
    expect(reviewer.findings?.[0]).toMatchObject({ status: 'unverified' })
  })

  it('withholds approval when a reviewer approves beside a located blocker', async () => {
    const quote: ReviewEvidence = { kind: 'quote', text: 'deploy on Friday night', file: 'plan.md' }
    const reviewer = reviewerReporting(quote, 'APPROVE')
    const judged = await judgeReviewer(pipeline, reviewer, 'APPROVE', host())
    expect(judged).toMatchObject({ blocks: true, note: expect.stringContaining('withheld') })
    expect(reviewer.findings?.[0]).toMatchObject({ status: 'located' })
  })

  it('keeps blocking when the expected output is too long to check', async () => {
    const repro = join(workspace, 'repro.js')
    await writeFile(repro, 'process.exit(1)\n')
    const tooLong: ReviewEvidence = {
      kind: 'command',
      program: process.execPath,
      args: ['repro.js'],
      expect: 'fail',
      output: 'x'.repeat(2_001)
    }
    const reviewer = reviewerReporting(tooLong, 'APPROVE')
    const judged = await judgeReviewer(pipeline, reviewer, 'APPROVE', host())
    expect(judged.blocks).toBe(true)
    expect(reviewer.findings?.[0]).toMatchObject({
      status: 'unverified',
      evidence: { outputInvalid: true },
      detail: expect.stringContaining('not usable text')
    })
  })
})
