import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { workflowTemplate } from '../../../../src/shared/workflow-graph-templates'
import { WORKFLOW_ROUTE_MODELS } from '../../../../src/main/runtime/workflow-script/local-workflow-models'
import { scoreDiscoverRun, type AnswerKey } from './discover-score'
import type { WorkflowRunResult } from '../../../../src/shared/workflow-run-result'

const read = <T>(file: string): T => JSON.parse(readFileSync(join(__dirname, file), 'utf8'))
const key = read<AnswerKey>('discover-seeded/answer-key.json')
const baseline = read<Record<string, Record<string, string[]>>>('discover-defaults.json')

// Existing defaults predate this gate; this baseline records no benchmark claim.
describe('Discover default model promotion gate', () => {
  for (const template of ['discover', 'quick-discover'] as const) {
    it(`${template}: changed defaults need committed seeded results that beat the previous default`, () => {
      const spec = workflowTemplate(template, ['claude', 'codex', 'grok'])
      const choices = Object.fromEntries(
        spec.steps.map((step) => [
          step.id,
          step.agents.map((agent) => {
            const models = WORKFLOW_ROUTE_MODELS[agent.route]
            const model = models.find((model) =>
              agent.model ? model.id === agent.model : model.isDefault
            )!
            return `${agent.route}:${model.resolved}`
          })
        ])
      )
      if (JSON.stringify(choices) === JSON.stringify(baseline[template])) {
        return
      }
      const promotion = read<{
        choices: typeof choices
        previous: WorkflowRunResult
        candidate: WorkflowRunResult
        set: string
        version: number
      }>(`promotions/${template}.json`)
      expect(promotion.choices).toEqual(choices)
      expect([promotion.set, promotion.version]).toEqual([key.set, key.version])
      for (const run of [promotion.previous, promotion.candidate]) {
        expect(run.state).toBe('completed')
        expect(run.template).toBe(template)
        expect(run.calls.length).toBeGreaterThan(0)
      }
      for (const [step, models] of Object.entries(choices)) {
        const actual = promotion.candidate.calls
          .filter((call) => call.stage === step)
          .map((call) => `${call.route}:${call.model}`)
        expect(actual.length).toBeGreaterThan(0)
        expect(actual.every((model) => models.includes(model))).toBe(true)
        expect(models.every((model) => actual.includes(model))).toBe(true)
      }
      const before = scoreDiscoverRun(promotion.previous, key)
      const after = scoreDiscoverRun(promotion.candidate, key)
      const metrics = (score: typeof before) => [
        score.recallAnyVerdict,
        score.precisionAnyVerdict ?? 0,
        score.ranking.meanReciprocalRank
      ]
      expect(metrics(after).every((value, index) => value >= metrics(before)[index]!)).toBe(true)
      expect(metrics(after).some((value, index) => value > metrics(before)[index]!)).toBe(true)
    })
  }
})
