import { createHash } from 'node:crypto'
import { DECISION_RECIPES } from './decision-recipes-v1.mjs'
import { QUEUE_TRIAGE_RECIPES } from './decision-queue-recipes-v1.mjs'
import { queueTriageEnabled } from './decision-queue-configuration.mjs'

// These belong to the archived v1 contract; a changed pin or gate list needs a new recipe version.
const v1 = {
  model: 'jev-1.13.0',
  policyVersion: 1,
  admissionGates: ['scope_authorized', 'source_current', 'input_minimized']
}
export const DECISION_RECORD_GATES = [...v1.admissionGates]
const versions = new Map(
  Object.entries({ ...DECISION_RECIPES, ...QUEUE_TRIAGE_RECIPES }).map(([id, recipe]) => [
    `${id}@1`,
    { ...structuredClone(recipe), ...structuredClone(v1), policyId: `${id}@1` }
  ])
)

export function getDecisionRecipe(id, version = 1) {
  if (typeof id !== 'string' || !Number.isSafeInteger(version)) {
    return undefined
  }
  const recipe = versions.get(`${id}@${version}`)
  return recipe ? structuredClone(recipe) : undefined
}

export function recipeQuestionHash(recipe) {
  return createHash('sha256').update(JSON.stringify(recipe.questions)).digest('hex')
}

export function decisionRecipeRegistry(environment = process.env) {
  return [
    ...[...versions]
      .filter(
        ([key]) =>
          !Object.hasOwn(QUEUE_TRIAGE_RECIPES, key.split('@')[0]) || queueTriageEnabled(environment)
      )
      .map(([key, recipe]) => ({
        id: key.slice(0, key.lastIndexOf('@')),
        version: recipe.version,
        questionHash: recipeQuestionHash(recipe),
        model: recipe.model,
        policyId: recipe.policyId,
        policyVersion: recipe.policyVersion,
        status: 'advisory',
        independentCalibration: 'not-established',
        purpose: recipe.purpose,
        fields: recipe.fields,
        admissionGates: recipe.admissionGates,
        admissionEvidence: 'operator-attested; not authorization',
        semanticGates: [],
        displayOrder: Object.keys(recipe.questions),
        questions: recipe.questions
      })),
    {
      id: 'trace_review',
      version: null,
      status: 'reserved',
      owner: 'lane-a',
      purpose: 'Await concrete trace questions, permitted projection and independent label rubric.',
      executable: false
    }
  ]
}
