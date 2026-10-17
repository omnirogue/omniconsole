/**
 * Runs one bounded implement task twice on the same brief: once given to a single agent
 * ("direct"), once through the production templates (implement → independent review when a guard
 * family justifies it → deterministic QA, one repair at most). Both arms go through the existing
 * executor (`omni orchestration worker-start`); this file adds no scheduler of its own.
 */
import { join } from 'node:path'
import {
  independentReviewTriggers,
  renderOrchestrationTaskTemplate,
  type OrchestrationTaskTemplateId
} from '../../../../src/shared/orchestration-task-templates'
import type { ArmRun, BenchArm, StageRecord } from './direct-vs-coordinated-report'
import {
  runStage,
  type BenchDeps,
  type BenchOptions,
  type BenchTask,
  type Seat
} from './direct-vs-coordinated-stage'

function brief(id: OrchestrationTaskTemplateId, values: Record<string, string>): string {
  const rendered = renderOrchestrationTaskTemplate(id, values)
  if (!rendered.ok) {
    throw new Error(`${id} brief: ${rendered.problems.map((p) => p.detail).join(' ')}`)
  }
  return rendered.spec
}

function common(options: BenchOptions): Record<string, string> {
  return {
    owner: options.owner,
    host: options.host,
    branch: 'none (folder workspace, no git)'
  }
}

export function implementBrief(
  options: BenchOptions,
  task: BenchTask,
  dir: string,
  repair?: string
): string {
  return brief('implement', {
    ...common(options),
    objective: repair
      ? `Repair ${task.target} so it follows its section of SPEC.md. The first attempt did not pass.`
      : task.objective,
    scope: `Only files under ${dir}. Do not read or change anything outside it, and run no git commands.`,
    ...(repair ? { context: repair } : {}),
    acceptance: `In ${dir}, node --test ${task.publicTest} exits 0, and ${task.target} follows every rule of its section in SPEC.md (hidden acceptance tests check the spec, not only the public tests).`,
    evidence:
      'State the exact command, its exit code and the pass/fail counts in the worker_done body. No report file is needed.'
  })
}

export function reviewBrief(
  options: BenchOptions,
  task: BenchTask,
  dir: string,
  triggers: string[]
): string {
  return brief('independent-review', {
    ...common(options),
    objective: `Review ${task.target} against its section of SPEC.md for correctness and for ways the check can be bypassed.`,
    scope: `Read everything under ${dir}. Write only ${join(dir, 'REVIEW.md')}.`,
    reviewOf: `The implementation of ${task.target} in ${dir}.`,
    justification: `The change touches a guard family: ${triggers.join(', ')}.`,
    authorModel: `${options.implementer.agent}${options.implementer.model ? `, ${options.implementer.model}` : ''}`,
    acceptance:
      'REVIEW.md lists each finding against SPEC.md with file:line and ends with the VERDICT line.',
    evidence: `Save the review as ${join(dir, 'REVIEW.md')} and pass it as --report-path.`
  })
}

export function reviewVerdict(text: string | null): 'pass' | 'block' | 'unknown' {
  const matches = [...(text ?? '').matchAll(/VERDICT:\s*(pass|block)/gi)]
  const last = matches.at(-1)?.[1]?.toLowerCase()
  return last === 'pass' || last === 'block' ? last : 'unknown'
}

function failureTail(output: string): string {
  const lines = output.split('\n').filter((line) => !line.startsWith('# '))
  return lines.slice(-60).join('\n').slice(-4_000)
}

export async function runArm(
  deps: BenchDeps,
  options: BenchOptions,
  arm: BenchArm,
  task: BenchTask,
  rep: number
): Promise<ArmRun> {
  const startedAtMs = deps.now()
  const dir = deps.materialize(`${task.id}-${arm}-r${rep}`)
  const run: ArmRun = {
    arm,
    taskId: task.id,
    rep,
    startedAtMs,
    endedAtMs: startedAtMs,
    stages: [],
    qa: [],
    verified: false,
    firstPassVerified: false,
    retries: 0,
    humanInterventions: 0,
    coordinatorQuestions: 0,
    review: 'not-justified'
  }
  const stage = async (
    kind: StageRecord['stage'],
    spec: string,
    seat: Seat
  ): Promise<StageRecord> => {
    const outcome = await runStage(deps, options, {
      stage: kind,
      spec,
      title: `bench ${task.id} ${arm} r${rep} ${kind}`,
      seat
    })
    run.stages.push(outcome.record)
    run.coordinatorQuestions += outcome.questions
    run.humanInterventions += outcome.waitingOnHuman ? 1 : 0
    deps.log(`  ${kind}: ${outcome.record.outcome} (${outcome.record.dispatchId ?? 'no dispatch'})`)
    if (outcome.record.outcome !== 'succeeded') {
      throw new Error(`${kind} ${outcome.record.outcome}: ${outcome.record.detail ?? ''}`)
    }
    return outcome.record
  }
  const qa = async (): Promise<{ passed: boolean; output: string }> => {
    const qaStartedAtMs = deps.now()
    const result = await deps.verify(dir, task)
    run.qa.push({
      startedAtMs: qaStartedAtMs,
      endedAtMs: deps.now(),
      pass: result.pass,
      fail: result.fail
    })
    deps.log(`  qa: ${result.pass} pass, ${result.fail} fail`)
    return { passed: result.fail === 0 && result.pass > 0, output: result.output }
  }
  try {
    await stage('implement', implementBrief(options, task, dir), options.implementer)
    let findings: string | null = null
    const triggers = arm === 'coordinated' ? independentReviewTriggers(task.objective) : []
    if (triggers.length > 0) {
      const review = await stage(
        'review',
        reviewBrief(options, task, dir, triggers),
        options.reviewer
      )
      const written = deps.readText(join(dir, 'REVIEW.md'))
      run.review = reviewVerdict(written ?? review.detail ?? null)
      findings = run.review === 'block' ? (written ?? review.detail ?? null) : null
    }
    const first = await qa()
    run.firstPassVerified = first.passed
    run.verified = first.passed
    if (!first.passed || findings) {
      run.retries = 1
      // Why: with one agent and no workflow, a person is who carries the failure back to it.
      run.humanInterventions += arm === 'direct' ? 1 : 0
      const context = [
        first.passed ? '' : `Failing acceptance checks:\n${failureTail(first.output)}`,
        findings ? `Blocking review findings:\n${findings.slice(0, 4_000)}` : ''
      ]
        .filter(Boolean)
        .join('\n\n')
      await stage('repair', implementBrief(options, task, dir, context), options.implementer)
      run.verified = (await qa()).passed
    }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error)
  }
  run.endedAtMs = deps.now()
  return run
}
