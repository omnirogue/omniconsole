import { readFileSync } from 'node:fs'
import type { WorkflowRoute, WorkflowSpec } from '../../../src/shared/workflow-graph'
import { workflowPatchStep } from '../../../src/shared/workflow-graph-edit'
import { workflowSetFind } from '../../../src/shared/workflow-graph-find'
import { workflowSetImprove } from '../../../src/shared/workflow-graph-improve'
import { workflowTemplate } from '../../../src/shared/workflow-graph-templates'

/** Improve for the live probe: PROBE_ROUNDS, PROBE_CANDIDATES, PROBE_MULTI, PROBE_CHECK, PROBE_PROMPTS. */
export function probeImproveSpec(routes: readonly WorkflowRoute[]): WorkflowSpec {
  const template = workflowSetImprove(
    workflowTemplate('improve', routes),
    {
      candidates: Number(process.env.PROBE_CANDIDATES ?? 1),
      ...(process.env.PROBE_MULTI === '1' ? { models: { mode: 'multi' as const } } : {})
    },
    routes
  )
  return {
    ...template,
    repeat: {
      ...template.repeat!,
      maxRounds: Number(process.env.PROBE_ROUNDS ?? 4),
      ...(process.env.PROBE_CHECK ? { check: { command: process.env.PROBE_CHECK } } : {}),
      ...(process.env.PROBE_PROMPTS ? { prompts: JSON.parse(process.env.PROBE_PROMPTS) } : {})
    }
  }
}

/**
 * Find the best for the live probe: PROBE_FIND_COUNT, PROBE_FIND_VERSIONS=1 (complete versions), or
 * PROBE_FIND_LIST (one per line); PROBE_RUBRIC, PROBE_TOP, PROBE_KEEP.
 */
export function probeFindSpec(routes: readonly WorkflowRoute[]): WorkflowSpec {
  const listFile = process.env.PROBE_FIND_LIST
  const spec = workflowSetFind(
    workflowTemplate('find', routes, { count: Number(process.env.PROBE_FIND_COUNT ?? 30) }),
    {
      ...(listFile ? { items: readFileSync(listFile, 'utf8').split('\n') } : {}),
      ...(process.env.PROBE_FIND_VERSIONS
        ? {
            versions: true,
            ...(process.env.PROBE_CHECK ? { check: { command: process.env.PROBE_CHECK } } : {})
          }
        : {}),
      ...(process.env.PROBE_TOP ? { top: Number(process.env.PROBE_TOP) } : {}),
      ...(process.env.PROBE_KEEP ? { keep: Number(process.env.PROBE_KEEP) } : {})
    },
    routes
  )
  return process.env.PROBE_RUBRIC
    ? workflowPatchStep(spec, 'judge', { instruction: process.env.PROBE_RUBRIC })
    : spec
}
