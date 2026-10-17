import { workflowOriginalValue } from './workflow-strict-schema'
import type { ProcessResult } from '../../../shared/child-process/process-spec'
import type { LocalWorkflowRoute } from '../../../shared/local-workflow-seats'
import {
  describeJsonSchemaProblems,
  validateJsonSchema,
  type JsonSchema
} from '../../../shared/json-schema-validate'
import { workflowCallTimeoutMs } from './workflow-call-timeout'
import {
  parseGeminiResult,
  parseGrokResult,
  parseOpenRouterResult
} from './workflow-native-result-streams'
import {
  jsonLines,
  object,
  providerFailureText,
  requiredText,
  type NativeAnswer,
  type NativeResult
} from './workflow-native-result-lines'

export type { NativeResult } from './workflow-native-result-lines'
export { workflowUsageTokens } from './workflow-native-result-lines'

/**
 * The provider finished, but its answer was unusable (not JSON, empty, off-schema or semantically
 * rejected). Only these problems are worth telling the model on a retry; a timeout or a missing
 * session is the host's fault, not the answer's.
 */
export class WorkflowAnswerRejectedError extends Error {}

/** The launch ended a call whose output went silent (WORKFLOW_CALL_STALL_MS); retried once. */
export class WorkflowCallStalledError extends Error {}

/** How long a stalled call's output stayed silent before its launch ended it, if it did. */
export function workflowCallStalledAfter(result: ProcessResult): number | undefined {
  const after = (result as { stalledAfterMs?: unknown }).stalledAfterMs
  return typeof after === 'number' ? after : undefined
}

function parseCodex(stdout: string, answer: NativeAnswer): NativeResult {
  const events = jsonLines(stdout)
  const threads = events.filter((event) => event.type === 'thread.started')
  const completed = events.filter((event) => event.type === 'turn.completed')
  const messages = events.filter(
    (event) => event.type === 'item.completed' && object(event.item).type === 'agent_message'
  )
  if (events.some((event) => event.type === 'error' || event.type === 'turn.failed')) {
    const said = providerFailureText(stdout)
    throw new Error(`workflow provider reported a failed turn${said ? `: ${said}` : ''}`)
  }
  // Codex may send progress notes first (they can match the schema too); only the message that
  // directly precedes turn.completed is the answer.
  const final = messages.at(-1)
  if (
    threads.length !== 1 ||
    completed.length !== 1 ||
    !final ||
    events.at(-1) !== completed[0] ||
    events.at(-2) !== final
  ) {
    throw new Error('workflow result requires one complete attributable turn and one final message')
  }
  return {
    value: answer(requiredText(object(final.item).text)),
    providerSessionId: requiredText(threads[0].thread_id),
    usage: object(completed[0].usage)
  }
}

function parseClaude(
  stdout: string,
  answer: NativeAnswer,
  output: 'text' | undefined
): NativeResult {
  // Streamed and single-envelope output both end with the result line.
  const envelope = jsonLines(stdout).findLast((line) => line.type === 'result')
  if (
    !envelope ||
    envelope.type !== 'result' ||
    envelope.subtype !== 'success' ||
    envelope.is_error !== false
  ) {
    const said = providerFailureText(stdout)
    throw new Error(
      `workflow provider did not return a successful result${said ? `: ${said}` : ''}`
    )
  }
  return {
    // Text answers carry the final message in `result`; schema answers in structured_output.
    value:
      output === 'text'
        ? answer(requiredText(envelope.result))
        : object(envelope.structured_output),
    providerSessionId: requiredText(envelope.session_id),
    resolvedModels: Object.keys(object(envelope.modelUsage)),
    usage: object(envelope.usage)
  }
}

/** "15:00" or "1:00:00", the run view's clock; under a minute "45s". */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
  }
  return total < 60 ? `${total}s` : `${minutes}:${seconds}`
}

/**
 * Transport parsing does not confer route eligibility or commit an attempt. `timeoutMs` is the
 * call's own timeout, so a timed-out call records how long its process was given.
 */
export function parseWorkflowNativeResult(
  route: LocalWorkflowRoute,
  receipt: ProcessResult,
  schema: JsonSchema,
  validateSemantics: (value: unknown) => string | null,
  output?: 'text',
  timeoutMs?: number
): NativeResult {
  const stalled = workflowCallStalledAfter(receipt)
  if (stalled !== undefined) {
    throw new WorkflowCallStalledError(`stalled: no output for ${clock(stalled)}, so it was ended`)
  }
  if (receipt.stdoutTruncated || receipt.stderrTruncated) {
    throw new Error('workflow output overflow')
  }
  if (receipt.timedOut) {
    // Without its own timeout the call ran under the host's default for the launch mode.
    const given = workflowCallTimeoutMs(timeoutMs)
    throw new Error(given === undefined ? 'timed out' : `timed out after ${clock(given)}`)
  }
  if (receipt.code !== 0 || receipt.signal) {
    // The last thing the CLI said on stderr is usually why ("could not apply the sandbox …").
    // Codex and Claude also say why on stdout (a usage limit, a sign-in): kept beside it.
    const said = [
      receipt.stderr
        .split('\n')
        .map((line) => line.trim())
        .findLast(Boolean)
        ?.slice(0, 240),
      providerFailureText(receipt.stdout)
    ]
      .filter(Boolean)
      .join(' · ')
    const status = receipt.signal ? `signal ${receipt.signal}` : `exit ${receipt.code}`
    throw new Error(
      `workflow process did not complete successfully (${status})${said ? `: ${said}` : ''}`
    )
  }
  // Text answers are wrapped as { markdown } before the call's schema sees them.
  const answer: NativeAnswer =
    output === 'text'
      ? (text) => {
          const markdown = text.trim()
          if (!markdown) {
            throw new WorkflowAnswerRejectedError('workflow answer is empty')
          }
          return { markdown }
        }
      : (text) => {
          try {
            return JSON.parse(text)
          } catch (cause) {
            const reason = cause instanceof Error ? cause.message : String(cause)
            throw new WorkflowAnswerRejectedError(`the answer is not valid JSON (${reason})`)
          }
        }
  const result =
    route === 'openrouter' || route === 'ollama'
      ? parseOpenRouterResult(receipt.stdout, answer, route)
      : route === 'codex'
        ? parseCodex(receipt.stdout, answer)
        : route === 'grok'
          ? parseGrokResult(receipt.stdout, answer, output)
          : route === 'gemini'
            ? parseGeminiResult(receipt.stdout, answer)
            : parseClaude(receipt.stdout, answer, output)
  if ((route === 'openrouter' || route === 'codex') && output !== 'text') {
    result.value = workflowOriginalValue(schema, result.value)
  }
  const problems = validateJsonSchema(schema, result.value)
  if (problems.length) {
    throw new WorkflowAnswerRejectedError(describeJsonSchemaProblems(problems))
  }
  const semanticError = validateSemantics(result.value)
  if (semanticError) {
    throw new WorkflowAnswerRejectedError(semanticError)
  }
  return result
}
