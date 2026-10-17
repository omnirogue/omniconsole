import { DEFAULT_SESSION_ACTION_TEMPLATES } from './session-action-templates'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

// The built-in templates live next door so this file stays the preset registry; every importer still finds them here.
export { DEFAULT_SESSION_ACTION_TEMPLATES } from './session-action-templates'

/**
 * Action presets: one instruction template per node type, written for ANY kind of
 * work (research notes, video, audio, documents, code). A template never assumes a
 * repository; the workspace is a folder and the produced files are handed on by path.
 */
export type SessionActionPresetId =
  | 'research'
  | 'analyze'
  | 'plan'
  | 'implement'
  | 'improve'
  | 'synthesize'
  | 'verify'
  | 'review'
  | 'critique'
  | 'compare'
  | 'judge'
  | 'summarize'
  | 'test'
  | 'repair'

export const SESSION_ACTION_PRESET_IDS = [
  'research',
  'analyze',
  'plan',
  'implement',
  'improve',
  'synthesize',
  'verify',
  'review',
  'critique',
  'compare',
  'judge',
  'summarize',
  'test',
  'repair'
] as const satisfies readonly SessionActionPresetId[]

export function isSessionActionPresetId(value: unknown): value is SessionActionPresetId {
  return (
    typeof value === 'string' && (SESSION_ACTION_PRESET_IDS as readonly string[]).includes(value)
  )
}

/** Presets that issue a verdict: the estate's review policy applies to every one of them. */
export const SESSION_VERDICT_PRESET_IDS = [
  'review',
  'verify',
  'judge',
  'critique',
  'compare'
] as const satisfies readonly SessionActionPresetId[]

export function isSessionVerdictPresetId(value: unknown): value is SessionActionPresetId {
  return (
    typeof value === 'string' && (SESSION_VERDICT_PRESET_IDS as readonly string[]).includes(value)
  )
}

export const SESSION_ACTION_PRESET_LABELS: Record<SessionActionPresetId, string> = {
  research: 'Research',
  analyze: 'Analyze',
  plan: 'Plan',
  implement: 'Implement',
  improve: 'Improve',
  synthesize: 'Synthesize',
  verify: 'Verify',
  review: 'Review',
  critique: 'Critique',
  compare: 'Compare',
  judge: 'Judge',
  summarize: 'Summarize',
  test: 'Test',
  repair: 'Repair'
}

/**
 * The one-line instruction a step carries when the person typed none: the objective the
 * preset frames. Every preset has a non-empty one, so no role can compile to an empty
 * prompt and be dropped by the chain normalizer.
 */
export const SESSION_ACTION_PRESET_INSTRUCTIONS: Record<SessionActionPresetId, string> = {
  research: 'Research this further using the current work and context and return your findings.',
  analyze:
    'Here is the current work. Analyze it and return what is there, what is missing and what to decide.',
  plan: 'Here is the current work. Turn it into a plan with numbered steps and the files each step produces.',
  implement: 'Here is the current work. Produce the deliverable it asks for.',
  improve: 'Here is the current work. Improve it and return the updated result.',
  synthesize:
    'Here are the results. Combine them into one coherent result and say what you dropped.',
  verify:
    'Here is the current work. Verify it against its own checklist and report PASS or FAIL per item.',
  review:
    'Here is the current work. Review it and identify any important problems or improvements.',
  critique:
    'Here are the other results; you wrote none of them. Name concrete defects, missing requirements and unverified claims, each with where it is. Say plainly whether anything blocks.',
  compare:
    'Here are the results. Compare them side by side with evidence, and name what a decision still needs.',
  judge:
    'You judge these candidates; you wrote none of them. Refute each, then rank them best first by the exact candidate ids you were given, and name the one you rank first.',
  summarize:
    'Here are the results. Summarize them, keeping every decision, number and open question.',
  test: 'Here is the current work. Run the checks it declares and report PASS or FAIL per check with the output that proves it.',
  repair:
    'Here is the current work and its blocking findings. Repair only those findings and report how you checked each one.'
}

/**
 * The outcome-relative form of an action: what this step does to move the current state towards
 * the desired one. `{{doneWhen}}` and `{{outcome.title}}` are filled by the work plan, never by
 * renderSessionActionTemplate, so a legacy handoff keeps the plain instruction above.
 */
export const SESSION_ACTION_OUTCOME_INSTRUCTIONS: Partial<Record<SessionActionPresetId, string>> = {
  research:
    'Research what reaching this needs, and return your findings and the open questions: {{doneWhen}}',
  analyze: 'Analyze the gaps between the current state and: {{doneWhen}}',
  plan: 'Independently plan how to take the current state to: {{doneWhen}}',
  implement: 'Produce the deliverable that takes the current state to: {{doneWhen}}',
  improve: 'Improve the current result until it reaches: {{doneWhen}}',
  verify:
    'Check the current state against each of these one at a time and report PASS or FAIL with the evidence: {{doneWhen}}',
  summarize:
    'Summarize the current state against what "{{outcome.title}}" still needs: {{doneWhen}}'
}

export type SessionActionVariable =
  | 'objective'
  | 'input'
  | 'inputFiles'
  | 'outputDir'
  | 'workspacePath'

export const SESSION_ACTION_VARIABLES: readonly SessionActionVariable[] = [
  'objective',
  'input',
  'inputFiles',
  'outputDir',
  'workspacePath'
]

export const SESSION_ACTION_VARIABLE_INFO: Record<
  SessionActionVariable,
  { description: string; example: string }
> = {
  objective: {
    description: 'The instruction typed for this step.',
    example: 'Tighten the intro of the webinar script to 45 seconds.'
  },
  input: {
    description:
      'The tail of the previous session’s output (its last assistant message), read with an explicit line limit.',
    example: 'I rewrote the intro and saved it as intro-v2.md …'
  },
  inputFiles: {
    description:
      'Every file the previous step produced in its output folder, one path per line. Empty on the first step.',
    example: '/Users/me/Webinar/.omni/runs/chn_1/step_1/intro-v2.md'
  },
  outputDir: {
    description: 'The folder this step must write its produced files and its manifest into.',
    example: '/Users/me/Webinar/.omni/runs/chn_1/step_2'
  },
  workspacePath: {
    description: 'The workspace folder the session starts in. Git is optional.',
    example: '/Users/me/Webinar'
  }
}

export type SessionActionPresetActor = {
  agent?: TuiAgent
  model?: string
  effort?: string
  accountChoiceId?: string | null
}

export type SessionActionPresetRecipe = {
  template?: string
  actor?: SessionActionPresetActor
}

export type SessionActionPresetSettings = Partial<
  Record<SessionActionPresetId, SessionActionPresetRecipe>
>

function normalizeActor(value: unknown): SessionActionPresetActor | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  const actor: SessionActionPresetActor = {}
  if (isTuiAgent(record.agent)) {
    actor.agent = record.agent
  }
  if (typeof record.model === 'string' && record.model.trim()) {
    actor.model = record.model.trim()
  }
  if (typeof record.effort === 'string' && record.effort.trim()) {
    actor.effort = record.effort.trim()
  }
  if (typeof record.accountChoiceId === 'string' && record.accountChoiceId.trim()) {
    actor.accountChoiceId = record.accountChoiceId.trim()
  }
  return Object.keys(actor).length > 0 ? actor : undefined
}

export function normalizeSessionActionPresetSettings(value: unknown): SessionActionPresetSettings {
  const normalized: SessionActionPresetSettings = {}
  if (!value || typeof value !== 'object') {
    return normalized
  }
  for (const [id, raw] of Object.entries(value)) {
    if (!isSessionActionPresetId(id) || !raw || typeof raw !== 'object') {
      continue
    }
    const record = raw as Record<string, unknown>
    const recipe: SessionActionPresetRecipe = {}
    if (typeof record.template === 'string' && record.template.trim()) {
      recipe.template = record.template
    }
    const actor = normalizeActor(record.actor)
    if (actor) {
      recipe.actor = actor
    }
    if (Object.keys(recipe).length > 0) {
      normalized[id] = recipe
    }
  }
  return normalized
}

export function normalizeSessionActionPresetsByWorkspace(
  value: unknown
): Record<string, SessionActionPresetSettings> {
  const normalized: Record<string, SessionActionPresetSettings> = {}
  if (!value || typeof value !== 'object') {
    return normalized
  }
  for (const [workspacePath, raw] of Object.entries(value)) {
    const key = workspacePath.trim()
    if (!key) {
      continue
    }
    const presets = normalizeSessionActionPresetSettings(raw)
    if (Object.keys(presets).length > 0) {
      normalized[key] = presets
    }
  }
  return normalized
}

export type ResolvedSessionActionPreset = {
  id: SessionActionPresetId
  template: string
  actor: SessionActionPresetActor | undefined
  /** Where the template came from, so the UI can say what a launch will run. */
  source: 'workspace' | 'global' | 'default'
}

/** Workspace override wins over the global recipe, which wins over the built-in template. */
export function resolveSessionActionPreset(
  settings:
    | {
        sessionActionPresets?: SessionActionPresetSettings
        sessionActionPresetsByWorkspace?: Record<string, SessionActionPresetSettings>
      }
    | null
    | undefined,
  workspacePath: string | null | undefined,
  id: SessionActionPresetId
): ResolvedSessionActionPreset {
  const workspaceRecipe = workspacePath
    ? settings?.sessionActionPresetsByWorkspace?.[workspacePath]?.[id]
    : undefined
  const globalRecipe = settings?.sessionActionPresets?.[id]
  const template =
    workspaceRecipe?.template ?? globalRecipe?.template ?? DEFAULT_SESSION_ACTION_TEMPLATES[id]
  const source = workspaceRecipe?.template
    ? 'workspace'
    : globalRecipe?.template
      ? 'global'
      : 'default'
  return {
    id,
    template,
    actor: workspaceRecipe?.actor ?? globalRecipe?.actor,
    source
  }
}

export type SessionActionTemplateValues = Partial<Record<SessionActionVariable, string>>

/**
 * Substitute {{variable}} placeholders. Unknown placeholders are left in place so a
 * typo is visible in the launched prompt instead of silently vanishing.
 */
export function renderSessionActionTemplate(
  template: string,
  values: SessionActionTemplateValues
): string {
  return template.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (match, name: string) => {
    if ((SESSION_ACTION_VARIABLES as readonly string[]).includes(name)) {
      const value = values[name as SessionActionVariable]
      return value === undefined || value === '' ? '(none)' : value
    }
    return match
  })
}
