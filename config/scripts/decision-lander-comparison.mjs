import { queueTriageEnabled } from './decision-queue-configuration.mjs'
import { recordQueueHumanChoice } from './decision-queue-events.mjs'
import {
  evaluateQueueRecipe,
  persistQueueObservation,
  queueDeadline,
  queueText,
  unavailableQueueResult
} from './decision-queue-evaluation.mjs'

const recipeId = 'lander_group_comparison'
const fields = ['price', 'ctaText', 'primaryLink']
const value = (item, field) => {
  if (!queueText(item[field])) {
    return null
  }
  if (field !== 'primaryLink') {
    return item[field].trim()
  }
  try {
    const url = new URL(item[field])
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

export function checkLanderParity(items, options = {}) {
  if (!queueTriageEnabled(options.environment)) {
    return { status: 'disabled', passed: false, items: [] }
  }
  if (
    !Array.isArray(items) ||
    !items.length ||
    items.length > 100 ||
    items.some((item) => !item || !queueText(item.id) || !queueText(item.title)) ||
    new Set(items.map((item) => item.id)).size !== items.length
  ) {
    return { status: 'invalid_group', passed: false, items: [] }
  }
  const checks = fields.map((field) => {
    const values = items.map((item) => value(item, field))
    return {
      field,
      known: values.every((entry) => entry !== null),
      consistent: new Set(values).size === 1
    }
  })
  const rows = items.map((item) => ({
    id: item.id,
    reasons: checks.flatMap((check) =>
      !check.known
        ? [`${check.field}:missing_or_invalid_in_group`]
        : !check.consistent
          ? [`${check.field}:mismatch`]
          : []
    )
  }))
  return {
    status: 'checked',
    passed: rows.every((row) => !row.reasons.length),
    items: rows.map((row) => ({ ...row, passed: !row.reasons.length }))
  }
}

export async function compareLanderGroup(group, options = {}) {
  const fallback = {
    status: 'manual_review',
    proposedDefault: null,
    rankings: [],
    reviewItemIds: []
  }
  if (!queueTriageEnabled(options.environment)) {
    return { ...fallback, status: 'disabled' }
  }
  if (!group || group.scope !== 'draft_only' || !queueText(group.id)) {
    return fallback
  }
  const input = structuredClone(group)
  const parity = checkLanderParity(input.items, options)
  const itemIds = parity.items.map((item) => item.id)
  const base = { ...fallback, parity, reviewItemIds: itemIds }
  if (!itemIds.length) {
    return base
  }
  const started = performance.now()
  const remaining = queueDeadline(options)
  let result = unavailableQueueResult()
  const rankings = []
  if (parity.passed) {
    const projection = input.items.map(({ id, title, price, ctaText, primaryLink }) => ({
      id,
      title,
      price,
      ctaText,
      primaryLink
    }))
    for (const item of projection) {
      const timeoutMs = remaining()
      if (!timeoutMs) {
        result = unavailableQueueResult()
        break
      }
      result = await evaluateQueueRecipe(
        recipeId,
        {
          candidate: JSON.stringify(item),
          group: JSON.stringify(projection)
        },
        options,
        timeoutMs
      )
      if (result.status !== 'success' || result.disposition !== 'advisory') {
        break
      }
      rankings.push({
        id: item.id,
        score: result.answers.quality.score,
        confidence: result.answers.quality.confidence
      })
    }
  }
  if (!queueTriageEnabled(options.environment)) {
    return { ...fallback, status: 'disabled' }
  }
  rankings.sort((a, b) => b.score - a.score)
  // A tie or incomplete group never creates a default by input order.
  const winner =
    rankings.length === itemIds.length &&
    (rankings.length === 1 || rankings[0].score > rankings[1].score)
      ? rankings[0].id
      : null
  const suggestion = winner ? { winnerId: winner } : null
  const observationId = await persistQueueObservation(
    recipeId,
    { ...result, elapsedMs: performance.now() - started },
    input,
    {
      subjectId: input.id,
      itemIds,
      suggestion,
      parity,
      rankings: rankings.length === itemIds.length ? rankings : []
    },
    options
  )
  if (!observationId) {
    return { ...fallback, status: 'disabled' }
  }
  return {
    ...base,
    observationId,
    proposedDefault: winner,
    rankings: rankings.length === itemIds.length ? rankings : []
  }
}

export function confirmLanderGroup(event, options) {
  return recordQueueHumanChoice(recipeId, event, options)
}
