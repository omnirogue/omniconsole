import { ASSISTED_BRIEF_LIMITS } from './assisted-brief-types'

// Why: named models are copied verbatim from the person's request, never from AI output, so a
// draft cannot rename, downgrade or swap them. Everyday phrases are not models: "Sonnet 18",
// "Opus 27", "O1 visa" and "GPT-style" stay prose, so each shape below needs a real version.
/** Brand ids such as claude-fable-5-1[1m], gpt-6-astra or gemini-2.5-pro. */
const BRAND_ID =
  /(?:claude|gpt|gemini|grok|codex|llama|mistral|mixtral|deepseek|qwen|kimi|glm)(?:[-.:/][\w.\-[\]]+)+/
/** OpenAI o-series: a suffix (o3-mini) or an "OpenAI" / "model" cue before a bare o3. */
const O_SERIES = /o[1-9](?:-[\w.]+)+|(?<=\b(?:openai|models?)\s+)o[1-9]/
/** Spelled names: Claude Sonnet 4, GPT 5, Gemini 2.5. */
const SPELLED =
  /claude[ -](?:opus|sonnet|haiku|fable)[ -]\d+(?:[.-]\d+)*|(?:claude|gpt|gemini|grok)[ -]\d+(?:[.-]\d+)*/
/** Bare family words need a dotted or hyphenated version: Sonnet 4.6 or opus-4-1, not Sonnet 18. */
const FAMILY =
  /(?:opus|sonnet|haiku|fable|astra|argon|luna|sol|terra)(?: \d+\.\d+(?:\.\d+)*|-\d+(?:[.-]\d+)*)/
const MODEL_TOKEN = new RegExp(
  String.raw`(?<![\w\-.[\]/])(?:${[BRAND_ID, O_SERIES, SPELLED, FAMILY]
    .map((pattern) => pattern.source)
    .join('|')})(?![\w\-[])`,
  'gi'
)

function modelTokens(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.matchAll(MODEL_TOKEN)) {
    const token = match[0].replace(/[.\-:/]+$/, '')
    if (/\d/.test(token)) {
      tokens.push(token)
    }
  }
  return tokens
}

/** Model names the person wrote, first spelling kept, compared case-insensitively. */
export function extractNamedModels(text: string): string[] {
  const seen = new Set<string>()
  const named: string[] = []
  for (const token of modelTokens(text)) {
    const key = token.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    named.push(token)
    if (named.length >= ASSISTED_BRIEF_LIMITS.namedModels) {
      break
    }
  }
  return named
}

/** True when the text names a model the person did not name. */
export function mentionsUnnamedModel(text: string, named: readonly string[]): boolean {
  const allowed = new Set(named.map((model) => model.toLowerCase()))
  return modelTokens(text).some((token) => !allowed.has(token.toLowerCase()))
}
