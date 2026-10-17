import { readFindItems } from './workflow-find-items'
import {
  WORKFLOW_FIND_DEFAULT_COUNT,
  WORKFLOW_FIND_DEFAULT_KEEP,
  WORKFLOW_FIND_DEFAULT_TOP,
  WORKFLOW_FIND_DEFAULT_VERSIONS,
  WORKFLOW_FIND_MAX_COUNT,
  WORKFLOW_FIND_HARVEST_DEFAULT,
  WORKFLOW_FIND_HARVEST_MAX,
  WORKFLOW_FIND_HARVEST_MAX_QUERY_CHARS,
  WORKFLOW_FIND_MAX_ITEMS,
  WORKFLOW_FIND_MAX_KEEP,
  WORKFLOW_MAX_AGENTS_PER_STEP,
  WORKFLOW_MAX_RANK_CANDIDATES,
  type WorkflowFind
} from './workflow-graph'
import { normalizeWorkflowCheck } from './workflow-check-normalize'
import { clampInt } from './workflow-spec-coercion'

/** The person's GitHub search, kept only when it is one; the query is never trimmed away. */
function normalizeHarvest(raw: unknown): { harvest?: WorkflowFind['harvest'] } {
  if (!raw || typeof raw !== 'object') {
    return {}
  }
  const record = raw as Record<string, unknown>
  if (typeof record.query !== 'string') {
    return {}
  }
  return {
    harvest: {
      query: record.query.slice(0, WORKFLOW_FIND_HARVEST_MAX_QUERY_CHARS),
      max: clampInt(record.max, 1, WORKFLOW_FIND_HARVEST_MAX, WORKFLOW_FIND_HARVEST_DEFAULT)
    }
  }
}

export function normalizeFind(raw: unknown): WorkflowFind | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }
  const record = raw as Record<string, unknown>
  const { items, itemDetails } = readFindItems(record.items, record.itemDetails)
  const versions = record.versions === true && !Array.isArray(record.items)
  // The receipt is the immutable import record, independent of itemDetails (a title-only import
  // keeps it too): once set, normalizing again (which would see an already-deduped list and
  // recompute an empty receipt) must never overwrite what really happened, so it is only ever
  // preserved here, never fabricated.
  const importReceipt =
    record.importReceipt && typeof record.importReceipt === 'object'
      ? (record.importReceipt as WorkflowFind['importReceipt'])
      : undefined
  const importMerged =
    typeof record.importMerged === 'number' ? record.importMerged : importReceipt?.merged
  return {
    count: versions
      ? clampInt(record.count, 2, WORKFLOW_MAX_AGENTS_PER_STEP, WORKFLOW_FIND_DEFAULT_VERSIONS)
      : clampInt(record.count, 2, WORKFLOW_FIND_MAX_COUNT, WORKFLOW_FIND_DEFAULT_COUNT),
    ...(versions ? { versions: true as const, ...normalizeWorkflowCheck(record.check) } : {}),
    // The person chose a list, even if it is still empty; validation asks for two options.
    ...(Array.isArray(record.items)
      ? {
          items: items.slice(0, WORKFLOW_FIND_MAX_ITEMS),
          ...(itemDetails ? { itemDetails: itemDetails.slice(0, WORKFLOW_FIND_MAX_ITEMS) } : {}),
          ...(importReceipt ? { importReceipt } : {}),
          ...(importMerged !== undefined ? { importMerged } : {})
        }
      : {}),
    // Complete versions are written, not found: a repository is never one of them.
    ...(versions ? {} : normalizeHarvest(record.harvest)),
    top: clampInt(record.top, 1, WORKFLOW_MAX_RANK_CANDIDATES, WORKFLOW_FIND_DEFAULT_TOP),
    ...(record.keep !== undefined
      ? { keep: clampInt(record.keep, 1, WORKFLOW_FIND_MAX_KEEP, WORKFLOW_FIND_DEFAULT_KEEP) }
      : {})
  }
}
