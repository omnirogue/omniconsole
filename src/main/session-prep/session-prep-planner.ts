import { z } from 'zod'
import { normalizePrepText } from '../../shared/session-prep-prompt'
import {
  SESSION_PREP_MAX_ITEMS,
  type PlannedItem,
  type PrepAgentTemplateChoice,
  type PrepRepoChoice,
  type PrepRunText,
  type SessionPrepSource
} from '../../shared/session-prep-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { sanitizePlannedChoices, withStatedBatchEffort } from './session-prep-choices'
import { parseModelJson } from './session-prep-model-json'
import { isSessionPrepAccountFailure } from './session-prep-ids'
import { SessionPrepHostError } from './session-prep-execution-host'

export type SessionPrepCallDeps = {
  runText: PrepRunText
  agent: TuiAgent
  model: string
  effort: string
  timeoutMs: number
}

const plannedItemSchema = z.object({
  title: z.string(),
  ask: z.string(),
  anchor: z.string(),
  direct: z.boolean(),
  changesCode: z.boolean(),
  repoHint: z.string().optional(),
  after: z.array(z.number()).optional(),
  // Why catch: a malformed choice drops that choice, never the item.
  agent: z.string().optional().catch(undefined),
  model: z.string().optional().catch(undefined),
  effort: z.string().optional().catch(undefined),
  folder: z.string().optional().catch(undefined),
  host: z.string().optional().catch(undefined),
  agentTemplate: z.string().optional().catch(undefined)
})

const planReplySchema = z.object({
  items: z.array(plannedItemSchema)
})

function clampTitle(title: string): string {
  const trimmed = title.trim()
  return trimmed.length <= 60 ? trimmed : trimmed.slice(0, 60)
}

function refuseUnresolvedPlan(): never {
  // An unparsed request can name a different execution host, account or ordered set of sessions.
  throw new SessionPrepHostError(
    'Could not determine the session plan and destinations. No sessions launched. Try preparation again.'
  )
}

/** The person's own messages: a "User:" line plus its indented continuation lines. */
function userExcerptText(context: string): string {
  const kept: string[] = []
  let inUser = false
  for (const line of context.split('\n')) {
    if (line.startsWith('User:')) {
      inUser = true
      kept.push(line.slice('User:'.length))
    } else if (inUser && line.startsWith('  ')) {
      kept.push(line)
    } else {
      inUser = false
    }
  }
  return kept.join(' ')
}

// Why: an anchor made only of words every request carries ("the", "create new sessions") ties an
// item to nothing the person asked for.
const FILLER_WORDS = new Set(
  'a an and as at be by can create do for i if in is it launch make me my new of on or our please session sessions so start that the then this to up we with you'.split(
    ' '
  )
)

// Why spaces for punctuation: "login/docs" holds two words an anchor may start at.
function anchorText(value: string): string {
  return normalizePrepText(value.replace(/[^\p{L}\p{N}\s]/gu, ' '))
}

// Why: scripts written without spaces between words have no word starts to match from.
const STARTS_UNSPACED = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u

/** From a word start, so "ui" never matches inside "build" but "prototype" matches "prototypes". */
function anchorFound(haystack: string, needle: string): boolean {
  return STARTS_UNSPACED.test(needle)
    ? haystack.includes(needle)
    : ` ${haystack}`.includes(` ${needle}`)
}

function anchorAllowed(anchor: string, request: string, context: string): boolean {
  const needle = anchorText(anchor)
  if (!needle.split(' ').some((word) => word !== '' && !FILLER_WORDS.has(word))) {
    return false
  }
  return (
    anchorFound(anchorText(request), needle) ||
    anchorFound(anchorText(userExcerptText(context)), needle)
  )
}

function sanitizeAfter(
  after: number[] | undefined,
  index: number,
  count: number
): number[] | undefined {
  if (!after) {
    return undefined
  }
  const kept: number[] = []
  for (const value of after) {
    if (!Number.isInteger(value) || value < 0 || value >= count || value >= index) {
      continue
    }
    if (!kept.includes(value)) {
      kept.push(value)
    }
  }
  return kept.length > 0 ? kept : undefined
}

function buildPlanPrompt(input: {
  request: string
  context: string
  source: SessionPrepSource
  repos: PrepRepoChoice[]
  agentTemplates?: PrepAgentTemplateChoice[]
}): string {
  const repos =
    input.repos.length === 0
      ? 'none'
      : input.repos
          .map((repo) => `- ${repo.name} (${repo.selector}) on ${repo.host ?? 'local'}`)
          .join('\n')
  const templates = input.agentTemplates?.length
    ? input.agentTemplates.map((template) => template.name).join(', ')
    : 'none'
  return `Split the person's request into sessions. Never invent work. Do not use tools or read files: answer from the text below.

Person's request (verbatim):
${input.request}

Conversation excerpt (User:/Assistant: lines, most recent last):
${input.context || '(none)'}

Source agent: ${input.source.agent}

Registered repositories:
${repos}

Agent templates (standing instructions a session can start with): ${templates}

Return ONLY JSON:
{"items":[{"title":"","ask":"","anchor":"","direct":false,"changesCode":false,"repoHint":"","after":[],"agent":"","model":"","effort":"","folder":"","host":"","agentTemplate":""}]}

Rules:
- One item per distinct outcome the person asked to become its own session. At most ${SESSION_PREP_MAX_ITEMS} items.
- Never invent work the person did not ask for.
- anchor = exact words (a verbatim substring) from the person's request, OR from a User: line of the excerpt when the request refers back (e.g. "the 5 prototypes we discussed").
- title <= 60 characters.
- ask = a self-contained restatement of that one outcome.
- direct = true only when the ask is already a complete, specific instruction needing no research (e.g. "send the PR link to the review session").
- changesCode = true if the session will modify files in a repository.
- repoHint only if the person named a repository for that item; otherwise omit.
- after = earlier item indexes this one must follow, only when the person stated an order ("then", "after", "once X is done"); otherwise omit.
- agent / model / effort / folder / host / agentTemplate = only what the person stated for launching; omit anything they did not say. Never pick these yourself. A choice stated once for the whole request ("all on codex", "put them in X") goes on every item it covers.
  - agent: "claude", "codex", or "gemini" (or another agent id they named): "on codex", "use claude", "on gemini". "use opus 5.5" / "with astra 6" / "with sol 6.1" / "with gemini 4 argon" / "with gemini 3-8-flash" also implies its agent and model.
  - model: the model they named, normalized to its catalog id ("opus", "opus[1m]", "sonnet", "haiku", "fable", "gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-terra", "gemini-4-argon", "gemini-3.8-flash").
  - effort: low | medium | high | xhigh | max, only from their words ("high effort", "xhigh", "max effort", "low effort").
  - host: the execution Mac or SSH target exactly as the person named it. Preserve unknown hosts so the host can report missing setup. Never replace an unavailable host with local.
  - agentTemplate: the agent template's name from the list above, only when the person named it for the session ("as a reviewer", "use the Researcher template").
  - folder: the Conversations sidebar folder to file the sessions in, outermost first with " / " between names ("in a folder called Prototypes in an OmniRogue folder" → "OmniRogue / Prototypes"). Not a file-system path.
- Omit empty optional fields.`
}

export async function plan(
  input: {
    request: string
    context: string
    source: SessionPrepSource
    cwd: string
    repos: PrepRepoChoice[]
    agentTemplates?: PrepAgentTemplateChoice[]
  },
  deps: SessionPrepCallDeps
): Promise<{ items: PlannedItem[]; dropped: string[] }> {
  let raw: string
  try {
    raw = await deps.runText({
      cwd: input.cwd,
      prompt: buildPlanPrompt(input),
      agent: deps.agent,
      model: deps.model,
      effort: deps.effort,
      timeoutMs: deps.timeoutMs
    })
  } catch (error) {
    // An auth refusal cannot be repaired by asking the same helper to prepare a fallback item.
    if (isSessionPrepAccountFailure(error)) {
      throw error
    }
    return refuseUnresolvedPlan()
  }

  const parsed = parseModelJson(raw, planReplySchema)
  if (!parsed) {
    return refuseUnresolvedPlan()
  }

  const personText = `${input.request}\n${userExcerptText(input.context)}`
  const dropped: string[] = []
  const kept: PlannedItem[] = []
  // Why: `after` names the planner's own indexes; dropping an item shifts every later one.
  const newIndexOf = new Map<number, number>()
  parsed.items.forEach((item, originalIndex) => {
    const title = clampTitle(item.title)
    const ask = item.ask.trim()
    const anchor = item.anchor.trim()
    if (ask === '' || anchor === '' || title === '') {
      dropped.push(`Dropped "${title || ask || 'item'}": not found in your words`)
      return
    }
    if (!anchorAllowed(anchor, input.request, input.context)) {
      dropped.push(`Dropped "${title}": not found in your words`)
      return
    }
    const repoHint = item.repoHint?.trim()
    const choices = sanitizePlannedChoices(item, personText, input.agentTemplates)
    newIndexOf.set(originalIndex, kept.length)
    kept.push({
      title,
      ask,
      anchor,
      direct: item.direct,
      changesCode: item.changesCode,
      ...(repoHint ? { repoHint } : {}),
      ...(item.after ? { after: item.after } : {}),
      ...(choices ? { choices } : {})
    })
  })

  const clamped = kept.slice(0, SESSION_PREP_MAX_ITEMS)
  const items = clamped.map((item, index) => {
    const { after, ...rest } = item
    const remapped = after
      ?.map((value) => newIndexOf.get(value))
      .filter((value): value is number => value !== undefined)
    const keptAfter = sanitizeAfter(remapped, index, clamped.length)
    return keptAfter ? { ...rest, after: keptAfter } : rest
  })

  if (items.length === 0) {
    return refuseUnresolvedPlan()
  }
  const finalItems = withStatedBatchEffort(items, input.request)
  const conflictWarnings = detectBatchFileConflicts(finalItems)
  for (const warning of conflictWarnings) {
    dropped.push(warning)
  }
  return { items: finalItems, dropped }
}

const MIGRATION_NUM_RE = /\bmigrations\/(\d{4})_[A-Za-z0-9_.-]+\.sql\b/g
const EXPLICIT_PATH_RE =
  /\b(?:src|web|bff|scripts|migrations|tests)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+\b/g

/**
 * Detects when two parallel code-changing items in a batch reference the same SQL migration
 * number (e.g. migrations/0080_*.sql) or the exact same file path without an `after` dependency.
 */
export function detectBatchFileConflicts(items: PlannedItem[]): string[] {
  const warnings: string[] = []
  const migrationOwners = new Map<string, number>()
  const pathOwners = new Map<string, number>()

  items.forEach((item, index) => {
    if (!item.changesCode) {
      return
    }
    const repoKey = (item.repoHint ?? 'default').toLowerCase()
    const deps = new Set(item.after ?? [])

    for (const match of item.ask.matchAll(MIGRATION_NUM_RE)) {
      const migKey = `${repoKey}:migration:${match[1]}`
      const prev = migrationOwners.get(migKey)
      if (prev !== undefined && prev !== index && !deps.has(prev)) {
        warnings.push(
          `Conflict warning: "${item.title}" and "${items[prev].title}" both reference migration ${match[1]} without an ordering dependency`
        )
      } else {
        migrationOwners.set(migKey, index)
      }
    }

    for (const match of item.ask.matchAll(EXPLICIT_PATH_RE)) {
      const fileKey = `${repoKey}:path:${match[0]}`
      const prev = pathOwners.get(fileKey)
      if (prev !== undefined && prev !== index && !deps.has(prev)) {
        warnings.push(
          `Conflict warning: "${item.title}" and "${items[prev].title}" both touch ${match[0]} in parallel`
        )
      } else {
        pathOwners.set(fileKey, index)
      }
    }
  })

  return warnings
}
