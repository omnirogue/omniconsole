export const REMOVED_INSTRUCTION_LINE =
  '[OmniConsole removed a line that read as instructions to an AI]'

// Bounded gaps (.{0,80}) keep every pattern linear on a 2 MB line.
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  // ignore / disregard ... previous / all ... instructions
  /\b(?:ignor(?:e|ing)|disregard(?:ing)?|forget(?:ting)?|overrid(?:e|ing))\b.{0,80}?\b(?:previous|prior|preceding|above|earlier|all|any|your|these|those|other)\b.{0,80}?\b(?:instructions?|prompts?|rules|directions|guidelines|directives)\b/i,
  // system / developer prompt
  /\b(?:system|developer)[\s_-]*(?:prompt|message|instructions?)\b/i,
  /\byou\s+are\s+now\b/i,
  // a line that speaks as a chat role
  /^[\s>#*_~`|([-]*(?:system|assistant|user|developer|human)\s*:/i,
  // chat-template role tokens
  /<\|[a-z0-9_]{1,40}\|>|\[\/?INST\]|<<\/?SYS>>|<\/?(?:system|assistant)(?:\s[^>]{0,80})?>/i,
  /\b(?:new|updated|hidden|secret)\s+instructions?\b/i,
  // do not tell the user
  /\b(?:do\s+not|don['\u2019]?t|never)\s+(?:tell|inform|mention|reveal|disclose|show|alert|let)\b.{0,40}?\b(?:user|human|operator|person)\b/i,
  // run / execute ... curl / bash / powershell
  /\b(?:run|running|execute|executing|exec|invoke|paste)\b.{0,80}?\b(?:curl|wget|bash|zsh|sh|powershell|pwsh|cmd(?:\.exe)?|iex|invoke-expression|invoke-webrequest)\b/i,
  // send / upload ... token / password / .env
  /\b(?:send(?:ing)?|upload(?:ing)?|forward(?:ing)?|transmit(?:ting)?|exfiltrat(?:e|ing)|leak(?:ing)?)\b.{0,80}?(?:\b(?:tokens?|passwords?|passwd|api[\s_-]?keys?|secrets?|credentials?|private\s+keys?|ssh\s+keys?|cookies?|session\s+ids?|id_rsa)\b|\.env\b)/i,
  // remote markdown or HTML images, which load (and leak) the moment they are rendered
  /!\[[^\]\n]{0,400}\]\(\s*<?\s*(?:https?:)?\/\//i,
  /<img\b[^>]{0,400}\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//i
]

/** True when a line reads as instructions to an AI rather than as content. */
export function readsAsInstructions(line: string): boolean {
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(line))
}

/** Replaces each line that reads as instructions with a fixed marker, and counts them. */
export function removeInstructionLines(text: string): { text: string; removedLines: number } {
  let removedLines = 0
  const lines = text.split('\n').map((line) => {
    if (!readsAsInstructions(line)) {
      return line
    }
    removedLines += 1
    return REMOVED_INSTRUCTION_LINE
  })
  return { text: lines.join('\n'), removedLines }
}
