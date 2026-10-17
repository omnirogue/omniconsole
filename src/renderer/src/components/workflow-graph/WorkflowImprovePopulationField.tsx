import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  WORKFLOW_MAX_POPULATION,
  type WorkflowRoute,
  type WorkflowSpec
} from '../../../../shared/workflow-graph'
import { improveStep, workflowSetImprove } from '../../../../shared/workflow-graph-improve'
import { WorkflowSelect } from './workflow-graph-controls'

function populationLabel(count: number): string {
  return count === 1
    ? translate('workflowGraph.improve.population.one', 'Only the best version')
    : translate(
        'workflowGraph.improve.population.many',
        'The best and up to {{count}} others that pass different cases',
        { count: count - 1 }
      )
}

/**
 * How many versions improvers build on each round: the best, plus versions that pass a practice
 * case the best fails. With a test, a nudge offers four of each, so every kept version gets a
 * new version built on it each round.
 */
export function WorkflowImprovePopulationField({
  spec,
  available,
  onChange
}: {
  spec: WorkflowSpec
  available: readonly WorkflowRoute[]
  onChange: (spec: WorkflowSpec) => void
}) {
  const repeat = spec.repeat!
  const candidates = improveStep(spec)?.agents.length ?? 1
  const population = repeat.population ?? 1
  const withPopulation = (next: WorkflowSpec, count: number): WorkflowSpec => {
    const { population: _previous, ...rest } = next.repeat!
    return { ...next, repeat: count > 1 ? { ...rest, population: count } : rest }
  }
  const nudge =
    !!repeat.check && (population < WORKFLOW_MAX_POPULATION || candidates < WORKFLOW_MAX_POPULATION)
  return (
    <div className="col-span-2 flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      <label className="flex flex-col gap-1">
        {translate('workflowGraph.improve.population.label', 'Versions to build on each round')}
        <WorkflowSelect
          value={String(population)}
          options={Array.from({ length: WORKFLOW_MAX_POPULATION }, (_, index) => ({
            value: String(index + 1),
            label: populationLabel(index + 1)
          }))}
          onChange={(value) => onChange(withPopulation(spec, Number(value)))}
        />
      </label>
      <span className="font-normal">
        {translate(
          'workflowGraph.improve.population.hint',
          'Each improver builds on one of them in turn. Versions that pass a practice case the best one fails are kept, so different strengths are not lost; without such a version, the strongest different approach is kept.'
        )}
      </span>
      {nudge ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="self-start px-0"
          onClick={() =>
            onChange(
              withPopulation(
                workflowSetImprove(
                  spec,
                  { candidates: Math.max(candidates, WORKFLOW_MAX_POPULATION) },
                  available
                ),
                WORKFLOW_MAX_POPULATION
              )
            )
          }
        >
          {translate(
            'workflowGraph.improve.population.nudge',
            'Use {{count}} a round (recommended with tests)',
            { count: WORKFLOW_MAX_POPULATION }
          )}
        </Button>
      ) : null}
    </div>
  )
}
