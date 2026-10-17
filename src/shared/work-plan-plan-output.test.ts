import { expect, it } from 'vitest'
import { planReportChain } from './__fixtures__/work-plan/plan-report-chain'
import { readWorkPlanArtifact } from './work-plan-artifact-schema'
import {
  planArtifactPathFor,
  workPlanOutputDirFor,
  workPlanPlanOutputContract
} from './work-plan-plan-output'

it('names the plan document inside the step output dir, and nowhere else', () => {
  const chain = planReportChain()
  expect(workPlanOutputDirFor(chain, 'plan-1')).toBe(
    '/workspace/launch/.omni/runs/chain-plan-report/plan-1'
  )
  expect(planArtifactPathFor(chain, 'plan-1')).toBe(
    '/workspace/launch/.omni/runs/chain-plan-report/plan-1/plan.json'
  )
  expect(planArtifactPathFor({ ...chain, workspacePath: 'C:\\work\\launch' }, 'plan-1')).toBe(
    'C:\\work\\launch\\.omni\\runs\\chain-plan-report\\plan-1\\plan.json'
  )
})

it('tells the planner to plan, to write both files in the output dir, and to change nothing else', () => {
  const contract = workPlanPlanOutputContract({
    outputDir: '/workspace/launch/.omni/runs/chain/plan-1',
    outputKind: 'plan',
    doneWhen: ['the page states the offer and the price']
  })
  expect(contract).toContain('PLAN this work. Do not implement it.')
  expect(contract).toContain('- the page states the offer and the price')
  expect(contract).toContain('/workspace/launch/.omni/runs/chain/plan-1')
  expect(contract).toContain('plan.json')
  expect(contract).toContain('plan.md')
  expect(contract).toContain('Change NO other file in the workspace')
  expect(contract).toContain('End your reply with one line stating that you verified')
  expect(contract).not.toContain('Produce a MOCKUP')
  expect(contract).not.toContain('one self-contained HTML mockup')
})

it('asks a mockup step for built HTML files it also lists in the document', () => {
  const contract = workPlanPlanOutputContract({
    outputDir: '/out',
    outputKind: 'mockup'
  })
  expect(contract).toContain('Produce a MOCKUP')
  expect(contract).toContain('one self-contained HTML mockup per screen')
  expect(contract).toContain('`mockups`')
})

it('embeds a shape that is itself a valid work-plan-v1 document once filled in', () => {
  const contract = workPlanPlanOutputContract({ outputDir: '/out', outputKind: 'plan' })
  const shape = contract.slice(contract.indexOf('{'), contract.lastIndexOf('}') + 1)
  const parsed = readWorkPlanArtifact(shape)
  expect(parsed.ok, parsed.ok === false ? parsed.problem : '').toBe(true)
})
