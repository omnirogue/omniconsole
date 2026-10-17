import type { WorkflowRoute, WorkflowSpec, WorkflowValidation } from './workflow-graph'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import { validateWorkflowSpec } from './workflow-graph-validate'
import { withTierModels, type WorkflowCompileModels } from './workflow-compile-tier-models'
import { DEFAULT_WORKFLOW_MODEL_TIERS } from './workflow-model-tiers'
export type { WorkflowCompileModels } from './workflow-compile-tier-models'

/**
 * Natural language → workflow graph. One read-only model call (the assisted-brief one-shot agent)
 * answers with JSON; `normalizeWorkflowSpec` fills every default and `validateWorkflowSpec`
 * checks it, exactly as the host will at Start. One repair turn gets the problems back; what is
 * still invalid opens in the editor with the problems pinned to their steps.
 */
export const WORKFLOW_COMPILE_GUIDE = `You turn a description of a multi-agent workflow into a workflow graph for Omni-IDE.

A workflow is a small graph of steps. Every step runs one or more AI agents in parallel. Steps whose inputs are ready run at the same time; an input makes a step wait for another. There are exactly four kinds of step:
- "do": agents do the work (answer, research, draft, plan, find). Set "list": {"maxItems": N} when the step must return a list of items (areas, subtopics, findings) for a later step to handle one by one.
- "review": agents critique the work of their input steps and end with a verdict (pass, fail or unsure). Use it for critics, reviewers, fact-checkers and verifiers. It can only review a "do" or "synthesize" step.
- "rank": agents compare at least two anonymous answers from their input steps and rank them. Its input step needs two or more agents. Its "instruction" is the rubric the judges (and JEV) use; bulleted lines are scored as separate criteria. Judges: "jev": {"method": "auto", "only": true} means JEV judges and the agents step in only when JEV cannot judge or is unsure (the default for "JEV" or "use JEV only"); "jev": {"method": "auto"} means JEV and the agents both judge ("JEV + Claude", "JEV and models"); no "jev" means only the agents judge ("models only"). "method" may also be "rubric" (score each answer) or "pairwise" (compare every two answers in both orders); "auto" picks. A rank step that nothing reads ends the workflow with the winning answer itself (best of N).
- "synthesize": exactly one agent writes the single final answer from everything it receives. It needs at least two results to combine.
Two modifiers:
- "forEach": {"step": "<id>", "limit": N} runs the step once per item of an input step that has "list".
- "repeat" (at most one, at the top level): {"do": "<do step id>", "review": "<review or rank step id>", "until": "approved" | "nothing-new" | "plateau", "maxRounds": N}. "approved" (maxRounds 1-5) revises one draft until the reviewers pass it (the do step has exactly one agent). "nothing-new" (1-5) repeats a listing step and a forEach review of its items until a round finds nothing new. "plateau" (maxRounds 1-10) is Improve: each round the do step's agents make challengers to the best version so far, a "rank" step compares them with it blind, and a challenger replaces it only when it wins; add "patience": 1-4 (rounds in a row without improvement before stopping, default 2) and "explore": "low" | "normal" | "high" (how often to try substantially different approaches). The do step's agent count is the candidates per round (1-7); the same route on every agent is single-model, different routes is multi-model.
Rules: step ids are short lowercase slugs; "inputs" lists the ids of earlier steps whose output the step reads (a forEach source is also an input); no cycles; exactly one final step that nothing reads, and every other step must feed a later step; at most 12 steps and 8 agents per step. "agents" has one entry per agent. Set "route" only when the user names a model family: "claude", "codex" (GPT / OpenAI), "grok", "gemini", "openrouter" (OpenRouter requires an explicit "model" API id) or "ollama" (a local model; requires an explicit "model" tag the user named); otherwise give {} and the app spreads the families. When the user asks for a level of model instead of a family, give the agent {"tier": "cheap"} (cheap, low cost, budget, fast), {"tier": "standard"} (normal, balanced) or {"tier": "frontier"} (best, strongest, smartest); a step may carry "tier" itself to put all its agents on it. Google-family models (including Gemini and OpenRouter google/*) may only do "do" steps. Give an agent an "angle" when the user wants agents to take different perspectives, and a "system" (that seat's own system prompt: who it is and how it works) when the user gives seats different system prompts or personas.
Write a short, specific "instruction" for every step from the description (what these agents must do and how their output is used). Do not invent steps the user did not ask for, except a final "synthesize" when the user clearly wants one combined answer.
Put the question or task the workflow should work on in "task" when the description contains one; otherwise "".
List in "assumptions" anything you had to decide that the user did not say.

Answer with one JSON object and nothing else:
{"title": "...", "task": "...", "steps": [{"id": "...", "kind": "do|review|rank|synthesize", "title": "...", "instruction": "...", "agents": [{"route": "claude", "angle": "..."}], "inputs": ["..."], "forEach": {"step": "...", "limit": 12}, "list": {"maxItems": 8}, "jev": {"method": "rubric"}}], "repeat": {...}, "assumptions": ["..."]}
Omit "forEach", "list", "jev", "repeat" and "system" when they do not apply. When changing a workflow, change only what the request asks: "use 5 candidates" sets the Improve do step's agents to 5; "try more diverse approaches" sets "explore": "high"; "run until two rounds fail to improve" sets "patience": 2; "optimize for reliability" rewrites the rank step's instruction as a reliability rubric.

Examples.
"Have 4 agents independently research this, send their findings to 2 critics, then have one synthesizer produce the final answer using the research and criticism." →
{"title":"Research panel","task":"","steps":[{"id":"research","kind":"do","title":"Research","instruction":"Research the question independently and thoroughly. Show your evidence.","agents":[{},{},{},{}],"inputs":[]},{"id":"critics","kind":"review","title":"Critics","instruction":"Critique the research: what is wrong, unsupported, missing or contradictory across the responses?","agents":[{},{}],"inputs":["research"]},{"id":"final","kind":"synthesize","title":"Final answer","instruction":"Write the single best answer from the research, correcting everything the critics found.","agents":[{}],"inputs":["research","critics"]}],"assumptions":["The critics review all four research results together."]}
"Ask Claude, GPT, Grok and Gemini, have them rank each other blind, and let Claude decide." →
{"title":"Council","task":"","steps":[{"id":"answer","kind":"do","title":"Answers","instruction":"","agents":[{"route":"claude"},{"route":"codex"},{"route":"grok"},{"route":"gemini"}],"inputs":[]},{"id":"rank","kind":"rank","title":"Blind ranking","instruction":"","agents":[{"route":"claude"},{"route":"codex"},{"route":"grok"}],"inputs":["answer"]},{"id":"chair","kind":"synthesize","title":"Chairman","instruction":"Write the final answer from the answers and the rankings.","agents":[{"route":"claude"}],"inputs":["answer","rank"]}],"assumptions":["Gemini answers but does not rank, because Gemini never judges."]}
"Write a Facebook ad, have two critics review it, and rewrite it until they both approve (max 3 tries)." →
{"title":"Ad with critics","task":"Write a Facebook ad","steps":[{"id":"draft","kind":"do","title":"Draft","instruction":"Write the ad.","agents":[{}],"inputs":[]},{"id":"critics","kind":"review","title":"Critics","instruction":"Review the ad for clarity, hook and claims. Pass it only if it is ready to run.","agents":[{},{}],"inputs":["draft"]}],"repeat":{"do":"draft","review":"critics","until":"approved","maxRounds":3},"assumptions":[]}
"Keep improving our pricing page headline until it stops getting better; 3 candidates a round from different models; JEV judges on clarity and conversion." →
{"title":"Improve","task":"Improve our pricing page headline","steps":[{"id":"improve","kind":"do","title":"Improve","instruction":"","agents":[{"route":"claude"},{"route":"codex"},{"route":"grok"}],"inputs":[]},{"id":"judge","kind":"rank","title":"Judge","instruction":"Judge which headline is best:\n- Clear at a glance\n- Likely to convert","agents":[{"route":"claude"},{"route":"codex"},{"route":"grok"}],"inputs":["improve"],"jev":{"method":"auto","only":true}}],"repeat":{"do":"improve","review":"judge","until":"plateau","maxRounds":6,"patience":2,"explore":"normal"},"assumptions":["Stops after 2 rounds without improvement, at most 6 rounds."]}`

export type WorkflowCompileResult = {
  spec: WorkflowSpec
  task: string
  assumptions: string[]
  validation: WorkflowValidation
}

/** The final test kept back never reaches a model; settleCompiled puts the person's back. */
function withoutSealed(spec: WorkflowSpec): WorkflowSpec {
  const check = spec.repeat?.check
  if (!check?.sealed) {
    return spec
  }
  const { sealed: _sealed, ...rest } = check
  return { ...spec, repeat: { ...spec.repeat!, check: rest } }
}

export function workflowCompilePrompt(input: {
  description: string
  /** The graph being edited: a follow-up message changes it rather than starting over. */
  current?: WorkflowSpec
  /** Problems the previous answer had, for the one repair turn. */
  problems?: string[]
}): string {
  const parts = [WORKFLOW_COMPILE_GUIDE]
  if (input.current) {
    parts.push(
      `The current workflow, which the request below changes (keep everything it does not mention):\n${JSON.stringify(withoutSealed(input.current))}`
    )
  }
  parts.push(`${input.current ? 'Change request' : 'Description'}:\n${input.description.trim()}`)
  if (input.problems?.length) {
    parts.push(
      `Your previous answer was not a valid workflow:\n${input.problems.map((problem) => `- ${problem}`).join('\n')}\nAnswer again with a corrected JSON object.`
    )
  }
  return parts.join('\n\n')
}

/** The first JSON object in a model's answer, fenced or bare. */
export function readWorkflowCompileJson(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
  const candidates = [fenced, text].filter((value): value is string => !!value)
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end <= start) {
      continue
    }
    try {
      const value: unknown = JSON.parse(candidate.slice(start, end + 1))
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

/** Reads, normalizes and validates one model answer. */
export function compileWorkflowAnswer(
  text: string,
  available: readonly WorkflowRoute[],
  models: WorkflowCompileModels = { tiers: DEFAULT_WORKFLOW_MODEL_TIERS }
): WorkflowCompileResult | { error: string } {
  const json = readWorkflowCompileJson(text)
  if (!json) {
    return { error: 'The answer was not a JSON workflow.' }
  }
  // Only a person types a page address: one a model wrote could carry data out in its query.
  const steps = Array.isArray(json.steps)
    ? json.steps.map((step: unknown) =>
        step && typeof step === 'object'
          ? withTierModels({ ...step, web: undefined }, available, models)
          : step
      )
    : json.steps
  const spec = normalizeWorkflowSpec({ ...json, steps, template: 'custom' }, available)
  return {
    spec,
    task: typeof json.task === 'string' ? json.task.trim() : '',
    assumptions: Array.isArray(json.assumptions)
      ? json.assumptions.filter((entry): entry is string => typeof entry === 'string').slice(0, 8)
      : [],
    validation: validateWorkflowSpec(spec, { available })
  }
}

/**
 * What a compile may and may not change. An edit keeps the workflow's template while it keeps
 * its kind of loop, so a described change ("use 5 candidates") never turns Improve into a custom
 * graph. And only a person types an objective check or rewords Improve's prompts: whatever a model
 * answers, the person's check and prompts stay exactly as they are while the workflow still
 * improves in rounds, and are never added or changed.
 */
function settleCompiled(
  result: WorkflowCompileResult,
  current: WorkflowSpec | undefined,
  available: readonly WorkflowRoute[]
): WorkflowCompileResult {
  const repeat = result.spec.repeat
  const sameLoop = !!current && current.repeat?.until === repeat?.until
  const improves = repeat?.until === 'plateau'
  const check = improves ? current?.repeat?.check : undefined
  const prompts = improves ? current?.repeat?.prompts : undefined
  const lostCheck = !!current?.repeat?.check && !check
  const lostPrompts = !!current?.repeat?.prompts && !prompts
  const removed =
    lostCheck && lostPrompts
      ? 'Your check and own prompts were removed: they apply'
      : lostCheck
        ? 'Your check was removed: it runs'
        : lostPrompts
          ? 'Your own prompts were removed: they apply'
          : undefined
  if (!sameLoop && !repeat?.check && !repeat?.prompts && !removed) {
    return result
  }
  const { check: _check, prompts: _prompts, ...rest } = repeat ?? {}
  const settled = normalizeWorkflowSpec(
    {
      ...result.spec,
      ...(sameLoop ? { template: current!.template } : {}),
      ...(repeat
        ? { repeat: { ...rest, ...(check ? { check } : {}), ...(prompts ? { prompts } : {}) } }
        : {})
    },
    available
  )
  return {
    ...result,
    spec: settled,
    ...(removed
      ? {
          assumptions: [
            ...result.assumptions,
            `${removed} only while the workflow improves in rounds.`
          ]
        }
      : {}),
    validation: validateWorkflowSpec(settled, { available })
  }
}

/**
 * Only a person types a check: a compiled Find the best keeps the person's check for its complete
 * versions, and never one a model wrote.
 */
function settleFindCheck(
  result: WorkflowCompileResult,
  current: WorkflowSpec | undefined,
  available: readonly WorkflowRoute[]
): WorkflowCompileResult {
  const find = result.spec.find
  const kept = find?.versions ? current?.find?.check : undefined
  if (!find || (!find.check && !kept)) {
    return result
  }
  const { check: _check, ...rest } = find
  const spec = normalizeWorkflowSpec(
    { ...result.spec, find: { ...rest, ...(kept ? { check: kept } : {}) } },
    available
  )
  return { ...result, spec, validation: validateWorkflowSpec(spec, { available }) }
}

/**
 * Only a person types a GitHub search: a compiled Find the best keeps the person's own search
 * and never one a model wrote, whatever the description sounded like.
 */
function settleFindHarvest(
  result: WorkflowCompileResult,
  current: WorkflowSpec | undefined,
  available: readonly WorkflowRoute[]
): WorkflowCompileResult {
  const find = result.spec.find
  const kept = find && !find.versions ? current?.find?.harvest : undefined
  if (!find || (!find.harvest && !kept)) {
    return result
  }
  const { harvest: _harvest, ...rest } = find
  const spec = normalizeWorkflowSpec(
    { ...result.spec, find: { ...rest, ...(kept ? { harvest: kept } : {}) } },
    available
  )
  return { ...result, spec, validation: validateWorkflowSpec(spec, { available }) }
}

/** A person's page addresses stay on the step they were typed for; a compile never adds one. */
function settleWeb(
  result: WorkflowCompileResult,
  current: WorkflowSpec | undefined,
  available: readonly WorkflowRoute[]
): WorkflowCompileResult {
  const typed = new Map<string, { urls: string[] }>()
  for (const step of current?.steps ?? []) {
    if (step.web) {
      typed.set(step.id, step.web)
    }
  }
  if (!result.spec.steps.some((step) => typed.has(step.id))) {
    return result
  }
  const steps = result.spec.steps.map((step) =>
    typed.has(step.id) ? { ...step, web: typed.get(step.id) } : step
  )
  const spec = normalizeWorkflowSpec({ ...result.spec, steps }, available)
  return { ...result, spec, validation: validateWorkflowSpec(spec, { available }) }
}

/**
 * The whole compile: ask, check, and when the answer is invalid ask once more with its problems.
 * `ask` runs the model; the caller decides which agent and account.
 */
export async function compileWorkflowDescription(input: {
  description: string
  current?: WorkflowSpec
  available: readonly WorkflowRoute[]
  models?: WorkflowCompileModels
  ask: (prompt: string) => Promise<string>
}): Promise<WorkflowCompileResult | { error: string }> {
  const settle = (answer: WorkflowCompileResult | { error: string }) =>
    'error' in answer
      ? answer
      : settleWeb(
          settleFindHarvest(
            settleFindCheck(
              settleCompiled(answer, input.current, input.available),
              input.current,
              input.available
            ),
            input.current,
            input.available
          ),
          input.current,
          input.available
        )
  const first = settle(
    compileWorkflowAnswer(
      await input.ask(workflowCompilePrompt(input)),
      input.available,
      input.models
    )
  )
  const problems =
    'error' in first ? [first.error] : first.validation.problems.map((problem) => problem.message)
  if (!problems.length) {
    return first
  }
  const second = settle(
    compileWorkflowAnswer(
      await input.ask(workflowCompilePrompt({ ...input, problems })),
      input.available,
      input.models
    )
  )
  return 'error' in second ? first : second
}
