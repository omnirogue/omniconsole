import { openRouterModelMatches } from './workflow-openrouter-worker'
import {
  jsonLines,
  object,
  requiredText,
  textAfterLastTool,
  type NativeAnswer,
  type NativeResult
} from './workflow-native-result-lines'

function legacyGrokEnvelope(stdout: string): Record<string, unknown> | undefined {
  // Legacy frozen launches print one pretty-printed object; streamed ones print typed lines.
  try {
    const parsed = object(JSON.parse(stdout))
    return parsed.type === undefined ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Grok's legacy JSON envelope or its `streaming-json` lines (verified on 1.0.34). */
export function parseGrokResult(
  stdout: string,
  answer: NativeAnswer,
  output: 'text' | undefined
): NativeResult {
  const legacy = legacyGrokEnvelope(stdout)
  const lines = legacy ? [] : jsonLines(stdout)
  const envelope = legacy ?? lines.at(-1)
  if (!envelope || (!legacy && envelope.type !== 'end')) {
    throw new Error('workflow provider did not finish the turn')
  }
  if (lines.some((line) => line.type === 'error') || envelope.stopReason !== 'end_turn') {
    throw new Error('workflow provider did not finish the turn')
  }
  const text = () =>
    legacy
      ? requiredText(legacy.text)
      : textAfterLastTool(
          lines,
          (line) => line.type === 'tool_call' || line.type === 'tool_call_update',
          (line) => (line.type === 'text' && typeof line.data === 'string' ? line.data : undefined)
        )
  return {
    value: output === 'text' ? answer(text()) : object(envelope.structuredOutput),
    providerSessionId: requiredText(envelope.sessionId),
    providerRequestId: requiredText(envelope.requestId),
    resolvedModels: Object.keys(object(envelope.modelUsage)),
    usage: object(envelope.usage)
  }
}

/**
 * Gemini `stream-json` (verified on 0.59.0): one init first, one successful result last. Exit 0
 * alone proves nothing (an empty or blocked reply still exits 0), so status must be success.
 */
export function parseGeminiResult(stdout: string, answer: NativeAnswer): NativeResult {
  const lines = jsonLines(stdout)
  const inits = lines.filter((line) => line.type === 'init')
  const results = lines.filter((line) => line.type === 'result')
  const result = lines.at(-1)
  if (
    inits.length !== 1 ||
    lines[0] !== inits[0] ||
    results.length !== 1 ||
    result !== results[0] ||
    result.status !== 'success' ||
    lines.some((line) => line.type === 'error' && line.severity !== 'warning')
  ) {
    throw new Error('workflow provider did not return a successful result')
  }
  const stats = object(result.stats)
  const text = textAfterLastTool(
    lines,
    (line) => line.type === 'tool_use' || line.type === 'tool_result',
    (line) =>
      line.type === 'message' && line.role === 'assistant' && typeof line.content === 'string'
        ? line.content
        : undefined
  )
  const input = Number(stats.input_tokens ?? 0)
  const outputTokens = Number(stats.output_tokens ?? 0)
  const total = Number(stats.total_tokens ?? 0)
  return {
    value: answer(text.trim()),
    providerSessionId: requiredText(inits[0].session_id),
    resolvedModels: Object.keys(object(stats.models)),
    // Gemini does not list thinking tokens; they are the remainder of the total.
    usage: { ...stats, thoughts_tokens: Math.max(0, total - input - outputTokens) }
  }
}

/** Also reads the Ollama worker, which emits the same lines. */
export function parseOpenRouterResult(
  stdout: string,
  answer: NativeAnswer,
  route: 'openrouter' | 'ollama' = 'openrouter'
): NativeResult {
  const lines = jsonLines(stdout)
  const init = lines[0]
  const result = lines.at(-1)
  if (
    init?.type !== 'init' ||
    result?.type !== 'result' ||
    lines.filter((line) => line.type === 'init').length !== 1 ||
    lines.filter((line) => line.type === 'result').length !== 1 ||
    lines.some((line) => line.type !== 'init' && line.type !== 'result' && line.type !== 'tool') ||
    !openRouterModelMatches(requiredText(result.requested_model), requiredText(result.model))
  ) {
    throw new Error(
      `${route === 'ollama' ? 'Ollama' : 'OpenRouter'} did not return an attributable result`
    )
  }
  return {
    value: answer(requiredText(result.text)),
    providerSessionId: requiredText(init.session_id),
    providerRequestId: requiredText(result.id),
    resolvedModels: [requiredText(result.requested_model)],
    usage: object(result.usage)
  }
}
