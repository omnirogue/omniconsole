import type { BuildReviewNoteInput } from '../../../shared/build-review-note'
import type {
  BuildReviewPipelineSnapshot,
  BuildReviewWorkerSnapshot
} from '../../../shared/build-review-pipeline'
import { reviewVerdict } from '../../../shared/build-review-pipeline'
import { buildBuilderSpec, buildReviewerSpec, describeAgentChoice } from './build-review-briefs'
import { createWorker, pushEvent, setStage } from './build-review-pipeline-state'
import {
  assertNotCancelled,
  pipelineHost,
  waitForWorker,
  type ActiveRun,
  type WorkerLifecycleContext
} from './build-review-worker-lifecycle'
import { runWorkerUnit } from './build-review-worker-unit'
import { runReviewersInParallel } from './build-review-parallel-reviews'
import { reviewEvidenceWorkspace, type ReviewEvidenceHost } from './build-review-evidence'
import {
  describeReviewerFindings,
  judgeReviewer,
  previousFindingsForSeat
} from './build-review-reviewer-judgement'

export async function executeReviewRounds(
  ctx: WorkerLifecycleContext,
  pipeline: BuildReviewPipelineSnapshot,
  run: ActiveRun,
  createTask: (title: string, spec: string) => Promise<string>
): Promise<void> {
  const choices = (pipeline.reviewers ?? [pipeline.reviewer]).map((worker) => worker.choice)
  const builderChoice = pipeline.builder.choice
  const maxRounds = pipeline.maxReviewRounds ?? 1
  const modified = new Set<string>()
  let findings = ''
  // Why: a bound pipeline leaves its facts on the card as evidence; a refused
  // or unreachable omnios is reported on the pipeline and never fails the work.
  const record = async (
    round: number,
    input: Omit<BuildReviewNoteInput, 'hubTaskId' | 'pipelineId' | 'runId' | 'round'>
  ): Promise<void> => {
    if (!pipeline.hubTaskId || !ctx.reportReview) {
      return
    }
    const result = await ctx.reportReview({
      hubTaskId: pipeline.hubTaskId,
      pipelineId: pipeline.id,
      runId: pipeline.runId,
      round,
      ...input
    })
    pushEvent(
      pipeline,
      result.ok ? 'info' : 'error',
      'pipeline',
      result.ok
        ? `Recorded on card ${pipeline.hubTaskId}: ${input.event} (${result.noteId})`
        : `Could not record ${input.event} on card ${pipeline.hubTaskId}: ${result.message}`
    )
    ctx.changed(pipeline)
  }
  const execute = async (worker: BuildReviewWorkerSnapshot, title: string, spec: string) =>
    runWorkerUnit({
      ctx,
      host: pipelineHost(ctx, pipeline),
      run,
      worker,
      title,
      spec,
      createTask,
      waitForReport: (unit) => waitForWorker(ctx, pipeline, run, unit)
    })
  for (let round = 1; round <= maxRounds; round += 1) {
    assertNotCancelled(run)
    pipeline.round = round
    if (round > 1) {
      pipeline.builder = createWorker('builder', builderChoice)
      pipeline.reviewers = choices.map((choice) => createWorker('reviewer', choice))
      pipeline.reviewer = pipeline.reviewers[0]!
    }
    setStage(pipeline, 'building')
    pushEvent(pipeline, 'info', 'pipeline', `Round ${round} of ${maxRounds}: building`)
    ctx.changed(pipeline)
    const repair = findings
      ? [
          '',
          'Previous review findings to fix:',
          findings,
          '',
          'Fix all findings in the existing working tree and rerun the relevant checks.',
          'Preserve prior changes; report what you fixed and any unresolved findings.'
        ].join('\n')
      : ''
    await execute(
      pipeline.builder,
      `Build · round ${round}`,
      buildBuilderSpec({ objective: pipeline.objective }) + repair
    )
    const files = pipeline.builder.report?.filesModified ?? []
    files.forEach((file) => modified.add(file))
    await record(round, {
      event: 'build_reported',
      worker: describeAgentChoice(builderChoice),
      outcome: pipeline.builder.status === 'succeeded' ? 'succeeded' : 'failed',
      reportPath: pipeline.builder.report?.reportPath ?? null,
      filesModified: files,
      detail: pipeline.builder.report?.subject
    })
    const builderFailed = pipeline.builder.status !== 'succeeded'
    if (builderFailed) {
      if (files.length === 0) {
        throw new Error('The builder reported failure; review skipped.')
      }
      pushEvent(
        pipeline,
        'info',
        'pipeline',
        `Builder reported failure but modified ${files.length} file(s); reviewing the change anyway — read its report for what it left undone.`
      )
    }
    setStage(pipeline, 'reviewing')
    const reviewers = pipeline.reviewers ?? [pipeline.reviewer]
    const reports: string[] = []
    let approved = true
    pipeline.reviewer = reviewers[0]!
    pushEvent(
      pipeline,
      'info',
      'pipeline',
      `Round ${round}: ${reviewers.length} reviewer(s) reviewing in parallel`
    )
    ctx.changed(pipeline)
    const evidence: ReviewEvidenceHost = {
      workspacePath: reviewEvidenceWorkspace(run),
      files: [...modified]
    }
    const lastRound = pipeline.rounds?.at(-1)
    const previous = pipeline.evidenceRequired
      ? await Promise.all(
          reviewers.map((_reviewer, index) =>
            previousFindingsForSeat(lastRound?.reviewers[index], evidence)
          )
        )
      : []
    await runReviewersInParallel({
      ctx,
      pipeline,
      run,
      reviewers,
      round,
      createTask,
      specFor: (index) =>
        buildReviewerSpec({
          objective: pipeline.objective,
          builderReportBody: [
            pipeline.builder.report?.body,
            pipeline.builder.report?.reportPath
              ? `Report artifact: ${pipeline.builder.report.reportPath}`
              : null
          ]
            .filter(Boolean)
            .join('\n'),
          filesModified: [...modified],
          reviewFocus: pipeline.reviewFocus,
          rubric: reviewers[index]!.choice.rubric,
          evidenceRequired: pipeline.evidenceRequired === true,
          previousFindings: previous[index] ?? null
        })
    })
    // Verdicts are read in seat order once every reviewer settled, so the record stays stable.
    for (const [index, reviewer] of reviewers.entries()) {
      if (reviewer.status !== 'succeeded') {
        throw new Error(
          `Reviewer ${index + 1} could not complete the review; approval is not established.`
        )
      }
      const verdict = reviewVerdict(reviewer.report?.body)
      if (!verdict) {
        throw new Error(
          `Reviewer ${index + 1} did not provide one valid verdict; approval is not established.`
        )
      }
      const judged = await judgeReviewer(pipeline, reviewer, verdict, evidence)
      approved &&= !judged.blocks
      if (judged.note) {
        pushEvent(pipeline, 'info', 'pipeline', `Reviewer ${index + 1}: ${judged.note}.`)
      }
      await record(round, {
        event: 'review_verdict',
        worker: describeAgentChoice(reviewer.choice),
        verdict,
        reportPath: reviewer.report?.reportPath ?? null,
        detail: reviewer.report?.subject
      })
      reports.push(
        `Reviewer ${index + 1} (${describeAgentChoice(reviewer.choice)}):\n${reviewer.report?.body ?? ''}${reviewer.report?.reportPath ? `\nReport artifact: ${reviewer.report.reportPath}` : ''}${reviewer.findings ? `\n${describeReviewerFindings(reviewer.findings)}` : ''}`
      )
    }
    pipeline.rounds ??= []
    pipeline.rounds.push(structuredClone({ number: round, builder: pipeline.builder, reviewers }))
    if (builderFailed) {
      // A build its own builder reported as failed is unfinished however the diff reads, and the
      // next builder is told so whatever the reviewers said.
      reports.push(
        `Pipeline: the builder reported failure this round, so the change cannot be approved. Finish the work its report left undone and report success.\nBuilder report:\n${pipeline.builder.report?.body ?? ''}`
      )
    }
    if (approved && builderFailed) {
      pushEvent(
        pipeline,
        'info',
        'pipeline',
        `Round ${round}: reviewers approved, but the builder reported failure; approval is withheld.`
      )
    }
    if (approved && !builderFailed) {
      await record(round, {
        event: 'review_approved',
        filesModified: [...modified],
        detail: `${reviewers.length} reviewer(s) approved in round ${round} of ${maxRounds}.`
      })
      if (pipeline.hubTaskId) {
        pushEvent(
          pipeline,
          'info',
          'pipeline',
          `All reviewers approved. Acceptance is decided on card ${pipeline.hubTaskId}: the builder's final_report and the hub's verification complete it, not this pipeline.`
        )
      }
      setStage(pipeline, 'completed')
      return
    }
    findings = reports.join('\n\n')
    if (round === maxRounds) {
      await record(round, {
        event: 'review_limit_reached',
        detail: findings.slice(0, 1200)
      })
      throw new Error(
        `Review limit reached after ${round} round(s); unresolved findings remain in the reviewer reports.`
      )
    }
    await record(round, { event: 'review_changes_requested', detail: findings.slice(0, 1200) })
    pushEvent(
      pipeline,
      'info',
      'pipeline',
      'Reviewers requested changes; sending findings back to the builder.'
    )
  }
}
