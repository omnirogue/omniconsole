import {
  WORKFLOW_DEFAULT_LIST_ITEMS,
  WORKFLOW_MAX_LIST_ITEMS,
  type WorkflowStep
} from './workflow-graph'
import { clampInt } from './workflow-spec-coercion'

/** A Do step's list option (`true` or an object); `evidence` is kept only when exactly true. */
export function normalizeWorkflowList(raw: unknown): NonNullable<WorkflowStep['list']> {
  const record = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : {}
  return {
    maxItems: clampInt(record.maxItems, 1, WORKFLOW_MAX_LIST_ITEMS, WORKFLOW_DEFAULT_LIST_ITEMS),
    ...(record.evidence === true ? { evidence: true as const } : {})
  }
}
