import type { GateFailure, PlannedItem, PreparedFields } from '../../shared/session-prep-types'
import {
  parseModelJson,
  PREP_JSON_RETRY_LINE,
  preparedFieldsSchema
} from './session-prep-model-json'
import type { SessionPrepCallDeps } from './session-prep-planner'
import { sessionPrepTaskTemplate } from './session-prep-task-template'

const PREPARED_SCHEMA_LINE =
  '{"title":string,"outcome":string,"doneWhen":string[],"decided":string[],"references":[{"path":string,"why":string}],"constraints":string[],"assumptions":string[],"blockingQuestion":null|{"question":string,"options":string[],"why":string},"changesCode":true|false,"effort":"low"|"medium"|"high"|"xhigh","repo":"<registered repository name>"|null}'

// Why in the preparer: it has just read the code, so it can size the work better than the planner.
const EFFORT_RULE =
  'effort = how hard the launched agent should think, from the difficulty and risk you found: "low" for docs, copy or a one-line change; "medium" for an ordinary feature or fix; "high" for multi-file work, architecture, or anything production-adjacent (payments, auth, data migrations, deploy config); "xhigh" only for the hardest (subtle concurrency, security, large cross-cutting refactors).'

function siblingTitles(siblings: PlannedItem[]): string {
  if (siblings.length === 0) {
    return 'none'
  }
  return siblings.map((item) => item.title).join(', ')
}

function repoList(repos: { name: string; path: string }[] | undefined): string {
  return repos?.length ? repos.map((repo) => `- ${repo.name}: ${repo.path}`).join('\n') : '(none)'
}

function buildPreparePrompt(input: {
  item: PlannedItem
  siblings: PlannedItem[]
  request: string
  context: string
  repos?: { name: string; path: string }[]
}): string {
  return `You are preparing the first message for a new autonomous agent session. Research the workspace READ-ONLY (read files, search) so the agent is pointed at the exact files, plans, schemas and decisions it needs. Change nothing.
The person's request (verbatim): ${input.request}
This session's part: ${input.item.ask} (their words: "${input.item.anchor}")
Other sessions in this batch (do not do their work): ${siblingTitles(input.siblings)}
Conversation excerpt (most recent last): ${input.context || '(none)'}
Registered repositories:
${repoList(input.repos)}
${sessionPrepTaskTemplate(input.request)}
The read-only and preparation-only instructions govern you, not the launched session. Do not copy them into the worker's constraints or turn the requested task into another preparation task.
Return ONLY a JSON object: ${PREPARED_SCHEMA_LINE}
Rules: repo = the registered repository name where this work must be done when it is not the current workspace (read its files at the path shown and cite them by absolute path); otherwise null. outcome = the finished end state in 1-2 sentences, observable, and nothing the person did not ask for. doneWhen = 3-6 checks someone could run or see (a command and its expected result, a screen, a file, an API response, required GitHub checks green). decided = only decisions the person or the conversation already made, attributed (put your own research findings in references, constraints or assumptions instead). references = only paths that exist, relative to the workspace root (absolute for files outside it, such as a document on the person's Desktop or another repository's files), each with why it matters. constraints = what the person ruled out or limited. assumptions = reversible choices you made instead of asking. blockingQuestion = ONLY for a fact or decision that nobody but the person can supply (a price, a name, a recipient, a date agreed with someone else, a credential only they hold, a choice between customer-facing policies) AND with no sensible reversible default — otherwise choose a default and put it in assumptions; never ask about anything the code, docs or conversation can answer. Never add production deploys, merges to protected branches, money movement, customer-facing sends or destructive operations unless the request explicitly asks for them. changesCode = true if the session will modify files in a repository. ${EFFORT_RULE}`
}

function buildRevisePrompt(input: {
  item: PlannedItem
  fields: PreparedFields
  failures: GateFailure[]
  request: string
  context: string
}): string {
  const missingRef = input.failures.some((failure) => failure.code === 'missing-reference')
  const research = missingRef
    ? 'A cited path was missing. Research the workspace READ-ONLY again only to replace missing references with paths that exist.'
    : 'Do not research again. Change only what the failures require.'
  const failureLines = input.failures
    .map((failure) => `- ${failure.code}: ${failure.detail}`)
    .join('\n')
  return `Correct the prepared session fields. Return ONLY the corrected JSON object.
The person's request (verbatim): ${input.request}
This session's part: ${input.item.ask} (their words: "${input.item.anchor}")
Conversation excerpt (most recent last): ${input.context || '(none)'}
Previous JSON fields:
${JSON.stringify(input.fields)}
Failures to fix:
${failureLines || '(none)'}
${research}
${sessionPrepTaskTemplate(input.request)}
For 'needless-question': drop blockingQuestion and record a sensible reversible default under assumptions.
For 'placeholder': resolve every placeholder by research or a stated default.
For 'unrequested-risk', 'contradiction', or 'not-ready': remove anything the person did not ask for and resolve conflicts in favour of the person's request.
Keep "effort" unless the corrections change how hard the work is.
Schema: ${PREPARED_SCHEMA_LINE}`
}

async function runPreparedJson(
  prompt: string,
  cwd: string,
  deps: SessionPrepCallDeps
): Promise<PreparedFields> {
  const request = {
    cwd,
    prompt,
    agent: deps.agent,
    model: deps.model,
    effort: deps.effort,
    timeoutMs: deps.timeoutMs
  }
  const firstRaw = await deps.runText(request)
  const first = parseModelJson(firstRaw, preparedFieldsSchema)
  if (first) {
    return first
  }
  // Why: the research is already in the first reply; reformatting it is seconds, redoing it minutes.
  const repair = `${PREP_JSON_RETRY_LINE}\nDo not research again: convert your previous reply below into the JSON object.\nSchema: ${PREPARED_SCHEMA_LINE}\nPrevious reply:\n${firstRaw.slice(-20_000)}`
  const retry = parseModelJson(
    await deps.runText({ ...request, prompt: repair }),
    preparedFieldsSchema
  )
  if (retry) {
    return retry
  }
  throw new Error('preparation returned no usable result')
}

export async function prepare(
  input: {
    item: PlannedItem
    index: number
    siblings: PlannedItem[]
    request: string
    context: string
    cwd: string
    repos?: { name: string; path: string }[]
  },
  deps: SessionPrepCallDeps
): Promise<PreparedFields> {
  return await runPreparedJson(buildPreparePrompt(input), input.cwd, deps)
}

export async function revise(
  input: {
    item: PlannedItem
    fields: PreparedFields
    failures: GateFailure[]
    request: string
    context: string
    cwd: string
  },
  deps: SessionPrepCallDeps
): Promise<PreparedFields> {
  const revised = await runPreparedJson(buildRevisePrompt(input), input.cwd, deps)
  // Why: a correction that drops the recommendation should not reset the effort to the default.
  return revised.effort || !input.fields.effort
    ? revised
    : { ...revised, effort: input.fields.effort }
}
