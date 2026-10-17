import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { reconcileSessionOutcomeSet } from '../../shared/session-outcome-state'
import { sessionOutcomePlanState } from '../../shared/session-outcome-plan-state'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcome, SessionOutcomeSet } from '../../shared/session-outcome-types'
import {
  planReportArtifact,
  planReportChain
} from '../../shared/__fixtures__/work-plan/plan-report-chain'
import {
  sessionOutcomeVerifiedEvidence,
  verifySessionOutcomeCondition
} from './session-outcome-evidence'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const PLAN_PATH = '.omni/runs/chain-plan-report/plan-1/plan.json'

async function workspace(git = true) {
  const path = await mkdtemp(join(tmpdir(), 'plan-evidence-'))
  folders.push(path)
  await mkdir(join(path, '.omni/runs/chain-plan-report/plan-1'), { recursive: true })
  if (git) {
    for (const args of [
      ['init'],
      ['config', 'user.email', 'test@example.com'],
      ['config', 'user.name', 'Test'],
      ['commit', '--allow-empty', '-m', 'seed']
    ]) {
      const result = await runProcess({ program: 'git', args: ['-C', path, ...args] })
      expect(result.code, result.stderr).toBe(0)
    }
  }
  return path
}

function chainFor(
  workspacePath: string,
  outputKind: SessionOutcome['outputKind'],
  extraConditions: SessionOutcome['conditions'] = []
): { chain: SessionChain; outcome: SessionOutcome } {
  const base = planReportChain()
  const outcome: SessionOutcome = {
    ...base.outcomeSet!.outcomes[0]!,
    outputKind,
    evidence: [],
    conditions: [...base.outcomeSet!.outcomes[0]!.conditions, ...extraConditions]
  }
  return {
    outcome,
    chain: {
      ...base,
      workspacePath,
      outcomeSet: { ...base.outcomeSet!, outcomes: [outcome] }
    }
  }
}

async function verify(
  workspacePath: string,
  outputKind: SessionOutcome['outputKind'],
  extraConditions: SessionOutcome['conditions'] = []
) {
  const { chain, outcome } = chainFor(workspacePath, outputKind, extraConditions)
  return verifySessionOutcomeCondition(
    outcome.conditions[0]!,
    workspacePath,
    undefined,
    chain,
    outcome.id
  )
}

it('leaves an empty plan.json unsatisfied', async () => {
  const path = await workspace()
  await writeFile(join(path, PLAN_PATH), '')
  const result = await verify(path, 'plan')
  expect(result).toEqual({
    verified: false,
    reason: `${PLAN_PATH} does not match work-plan-v1: The plan document is empty.`
  })
})

it('leaves a plan.json that fails the schema unsatisfied, naming the field', async () => {
  const path = await workspace()
  await writeFile(join(path, PLAN_PATH), JSON.stringify({ ...planReportArtifact(), steps: [] }))
  const result = await verify(path, 'plan')
  expect(result.verified).toBe(false)
  expect(result.verified === false && result.reason).toContain('steps')
})

it('accepts a valid plan on an untouched workspace, with the delivered bytes pinned', async () => {
  const path = await workspace()
  const bytes = JSON.stringify(planReportArtifact())
  await writeFile(join(path, PLAN_PATH), bytes)
  const result = await verify(path, 'plan')
  expect(result.verified).toBe(true)
  expect(result.verified && result.version).toBe(createHash('sha256').update(bytes).digest('hex'))
  // The receipt pins the bytes AND the real file it read them from, never the path as asked for.
  expect(result.verified && result.receipt).toBe(
    `sha256:${createHash('sha256').update(bytes).digest('hex')}:${await realpath(join(path, PLAN_PATH))}`
  )
})

it('refuses a plan step that changed the workspace, and says how many files', async () => {
  const path = await workspace()
  await writeFile(join(path, PLAN_PATH), JSON.stringify(planReportArtifact()))
  await writeFile(join(path, 'index.html'), '<h1>implemented instead of planned</h1>')
  await writeFile(join(path, 'styles.css'), 'body{}')
  const result = await verify(path, 'plan')
  expect(result.verified).toBe(false)
  expect(result.verified === false && result.reason).toContain(
    'plan step changed 2 workspace files'
  )
})

it('excludes a sibling’s declared output and the run folder from the check', async () => {
  const path = await workspace()
  await writeFile(join(path, PLAN_PATH), JSON.stringify(planReportArtifact()))
  // A sibling step's declared deliverable, and another step's report folder.
  await writeFile(join(path, 'research.md'), 'the sibling wrote this')
  await mkdir(join(path, '.omni/runs/chain-plan-report/research-1'), { recursive: true })
  await writeFile(join(path, '.omni/runs/chain-plan-report/research-1/report.md'), 'notes')
  const declared: SessionOutcome['conditions'] = [
    { id: 'dw-research', kind: 'file', target: 'research.md', label: 'the research notes' }
  ]
  expect((await verify(path, 'plan', declared)).verified).toBe(true)
})

it('blocks with "Verification failed" when the workspace cannot be observed', async () => {
  const path = await workspace(false)
  await writeFile(join(path, PLAN_PATH), JSON.stringify(planReportArtifact()))
  const result = await verify(path, 'plan')
  expect(result.verified).toBe(false)
  expect(result.verified === false && result.reason).toMatch(/^Verification failed: /)
  expect(result.verified === false && result.reason).not.toContain('unchanged')
})

it('requires a mockup outcome to have built every mockup it lists, inside its own directory', async () => {
  const path = await workspace()
  const plan = planReportArtifact()
  await writeFile(join(path, PLAN_PATH), JSON.stringify({ ...plan, mockups: [] }))
  expect(await verify(path, 'mockup')).toEqual({
    verified: false,
    reason: 'A mockup outcome needs at least one built mockup listed in its plan document.'
  })

  await writeFile(join(path, PLAN_PATH), JSON.stringify(plan))
  expect((await verify(path, 'mockup')).verified).toBe(false)

  await writeFile(join(path, '.omni/runs/chain-plan-report/plan-1/hero.html'), '<h1>hero</h1>')
  expect((await verify(path, 'mockup')).verified).toBe(true)
})

it('refuses a mockup that leaves the output directory, even through a link', async () => {
  const path = await workspace()
  // The document's own schema refuses `..`, so the only way out is a link the planner created.
  await symlink(path, join(path, '.omni/runs/chain-plan-report/plan-1/out'))
  await writeFile(join(path, 'hero.html'), '<h1>hero</h1>')
  await writeFile(
    join(path, PLAN_PATH),
    JSON.stringify({
      ...planReportArtifact(),
      mockups: [{ file: 'out/hero.html', title: 'Hero' }]
    })
  )
  const escaped = await verify(path, 'mockup')
  expect(escaped.verified).toBe(false)
  expect(escaped.verified === false && escaped.reason).toContain(
    "is not an HTML file inside the plan's output directory"
  )

  await writeFile(
    join(path, PLAN_PATH),
    JSON.stringify({ ...planReportArtifact(), mockups: [{ file: 'hero.txt', title: 'Hero' }] })
  )
  const wrongKind = await verify(path, 'mockup')
  expect(wrongKind.verified === false && wrongKind.reason).toContain('is not an HTML file')
})

it('never lets the row read plan-ready when the plan was written outside the output dir', async () => {
  const path = await workspace()
  // The planner wrote its plan to the workspace root instead of into its own output directory.
  await writeFile(join(path, 'plan.json'), JSON.stringify(planReportArtifact()))
  const { chain, outcome } = chainFor(path, 'plan')
  const result = await verifySessionOutcomeCondition(
    outcome.conditions[0]!,
    path,
    undefined,
    chain,
    outcome.id
  )
  expect(result).toEqual({
    verified: false,
    reason: 'The execution host cannot read the expected delivered file.'
  })
  // No receipt is written, so the state the sidebar reads stays `planning`.
  expect(sessionOutcomePlanState(chain)).toBe('planning')
})

it('leaves an ordinary work outcome alone: no schema, no workspace check', async () => {
  const path = await workspace()
  await writeFile(join(path, PLAN_PATH), 'not json at all')
  await writeFile(join(path, 'index.html'), 'the worker is allowed to write this')
  const base = planReportChain()
  const outcome: SessionOutcome = {
    ...base.outcomeSet!.outcomes[0]!,
    outputKind: 'work',
    evidence: [],
    conditions: [{ id: 'dw-plan', kind: 'file', target: PLAN_PATH }]
  }
  const result = await verifySessionOutcomeCondition(
    outcome.conditions[0]!,
    path,
    undefined,
    { ...base, workspacePath: path, outcomeSet: { ...base.outcomeSet!, outcomes: [outcome] } },
    outcome.id
  )
  expect(result.verified).toBe(true)
})

it('stamps the plan version on a receipt, and reconcile never rewrites it', () => {
  const outcome = planReportChain().outcomeSet!.outcomes[0]!
  const evidence = sessionOutcomeVerifiedEvidence(
    outcome,
    outcome.conditions[0]!,
    'sha256:receipt',
    1_750_000_000_000,
    'a'.repeat(64),
    4
  )
  expect(evidence.planVersion).toBe(4)
  expect(
    sessionOutcomeVerifiedEvidence(outcome, outcome.conditions[0]!, 'sha256:receipt').planVersion
  ).toBe(1)
  const set: SessionOutcomeSet = {
    ...planReportChain().outcomeSet!,
    outcomes: [{ ...outcome, evidence: [evidence] }]
  }
  expect(reconcileSessionOutcomeSet(set).outcomes[0]!.evidence[0]!.planVersion).toBe(4)
})
