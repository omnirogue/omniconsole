import { getDecisionRecipe } from './decision-recipe-registry.mjs'
export { DECISION_RECIPES } from './decision-recipes-v1.mjs'

export function buildRecipeRequest(recipeId, state, version = 1) {
  const recipe = getDecisionRecipe(recipeId, version)
  if (!recipe || !state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('invalid_recipe_input')
  }
  if (Object.keys(state).some((key) => !recipe.fields.includes(key))) {
    throw new Error('unexpected_state_field')
  }
  const projected = {}
  for (const key of recipe.fields) {
    if (typeof state[key] !== 'string' || state[key].length > 6000) {
      throw new Error('invalid_state_field')
    }
    projected[key] = state[key]
  }
  if (Buffer.byteLength(JSON.stringify(projected)) > 12_000) {
    throw new Error('input_too_large')
  }
  return {
    capability: `recipe_${recipeId}`,
    model: recipe.model,
    state: projected,
    questions: structuredClone(recipe.questions)
  }
}

export function recipeDisposition(recipeId, answers, version = 1) {
  const recipe = getDecisionRecipe(recipeId, version)
  if (!recipe || !answers || Object.keys(answers).length !== Object.keys(recipe.questions).length) {
    return 'unavailable'
  }
  for (const [id, question] of Object.entries(recipe.questions)) {
    const answer = answers[id]
    if (!answer || answer.type !== question.type) {
      return 'unavailable'
    }
    if (question.type === 'noul') {
      if (!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
        return 'unavailable'
      }
    } else if (
      !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 ||
      answer.confidence > 1
    ) {
      return 'unavailable'
    }
    if (question.type === 'choice' && !Object.hasOwn(question.criteria, answer.choice)) {
      return 'unavailable'
    }
    if (
      question.type === 'score' &&
      (!Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > question.criteria.length - 1)
    ) {
      return 'unavailable'
    }
  }
  if (recipe.policyVersion !== 1 || recipe.policyId !== `${recipeId}@1`) {
    return 'unavailable'
  }
  // Archived v1 hints, not calibrated probability thresholds or permission.
  if (Object.values(answers).some((answer) => answer.type !== 'noul' && answer.confidence < 0.9)) {
    return 'review'
  }
  if (
    recipeId === 'support_triage' &&
    (answers.sensitive.noul >= 0.1 || answers.route.choice === 'human')
  ) {
    return 'review'
  }
  if (
    recipeId === 'work_routing' &&
    (answers.consequential.noul >= 0.1 || answers.route.choice === 'human')
  ) {
    return 'review'
  }
  if (recipeId === 'advertising_review' && answers.alignment.choice !== 'aligned') {
    return 'review'
  }
  if (
    recipeId === 'evidence_review' &&
    (answers.alignment.choice !== 'supported' || answers.supported.noul < 0.9)
  ) {
    return 'review'
  }
  if (
    recipeId === 'retrieval_review' &&
    (answers.injection.noul >= 0.1 || answers.relevance.choice !== 'direct')
  ) {
    return 'review'
  }
  if (recipeId === 'lead_fit' && answers.fit.choice !== 'fit') {
    return 'review'
  }
  return 'advisory'
}
