export const SESSION_PROMPT_CONTEXT_SCAN_LIMIT = 32_768

const LAUNCH_CONTEXT_HEADER = '# Launch context (added by omni-launch-best;'
const LAUNCH_CONTEXT_FOOTER_START = '\nStart here: `slite-kb brief --scope '
const LAUNCH_CONTEXT_FOOTER_END =
  '` for this company and department, and `wis knowledge search --q "<task terms>"` for estate history.'
const PASTE_MARKER_RE = /\[(?:Pasted text #\d+(?: \+\d+ lines?)?|Image #\d+)\]/gi
const REQUESTED_RESULT_RE = /(?:^|\n)(?:## Requested result\s*\r?\n|Requested result:[ \t]*)/i
const BRIEF_HEADER_RE =
  /^# (?:Prepared launch brief[ \t]*(?:\r?\n|$)|SSH launch readiness[ \t]+[—-][ \t]+mw\d+[ \t]*(?:\r?\n|$))/i

/** Display repair only: never a reason to rewrite a custom title. */
export function isGeneratedPromptScaffoldTitle(title: string): boolean {
  return /^(?:Launch context added by omni launch best|Prepared launch brief|SSH launch readiness mw\d+(?: Requested)?|Image \d+(?:\s.*)?)$/i.test(
    title
  )
}

// Why: a leading paste marker in any provider's spelling ("[Pasted text #1 +40 lines]",
// "[Pasted content id:9fa8]", "<pasted …>", "[Image #1]") means the prompt opens with material.
const LEADING_PASTE_RE = /^[[<]\s*(?:pasted\b|image\s*#)/i
// Box drawing, block elements and braille: CLI banners and TUI screenshots, never an ask.
const TERMINAL_ART_RE = /[\u2500-\u259f\u2800-\u28ff]/u
const CLI_OUTPUT_LINE_RE =
  /^(?:[$%❯›>]\s|\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[?\d{2}:\d{2}:\d{2}|Traceback \(most recent call last\)|(?:npm|pnpm|yarn) (?:ERR|WARN)|(?:Error|TypeError|ReferenceError|SyntaxError): |at \S+ \(|Claude Code v\d)/i

/**
 * A first prompt that names nothing: it opens with a paste, a CLI banner or log output, or is
 * mostly symbols. Its first clause is junk as a title, so a better source (the agent's own
 * title) should win. Only ever steers the app's generated title, never a title someone set.
 */
export function isWeakTitlePrompt(prompt: string): boolean {
  const head = sessionPromptContent(prompt, 512).trimStart()
  if (!head) {
    return false
  }
  if (LEADING_PASTE_RE.test(head)) {
    return true
  }
  const firstLine = head.split(/\r?\n/, 1)[0]!.trim()
  // Why the opening only: a banner starts with its art; an ask may mention a box character later.
  if (TERMINAL_ART_RE.test(firstLine.slice(0, 24)) || CLI_OUTPUT_LINE_RE.test(firstLine)) {
    return true
  }
  const visible = head.replace(/\s+/g, '')
  const letters = visible.match(/\p{L}/gu)?.length ?? 0
  return visible.length >= 8 && letters / visible.length < 0.5
}

export function stripPromptPasteMarkers(text: string): string {
  return text.replace(PASTE_MARKER_RE, ' ')
}

function requestedResult(text: string): string {
  const match = REQUESTED_RESULT_RE.exec(text)
  return match ? text.slice(match.index + match[0].length).trimStart() : ''
}

// Why: a launch inside a project opens with its "Project: <name>" line (project-launch-inheritance).
const PROJECT_LINE_RE = /^Project: [^\r\n]{1,300}(?:\r?\n){2}/

/** Removes only recognized launcher scaffolding before applying each display's own text limit. */
export function sessionPromptContent(prompt: string, maxLength: number): string {
  const project = PROJECT_LINE_RE.exec(prompt.slice(0, 512).trimStart())
  if (project) {
    return sessionPromptContent(prompt.trimStart().slice(project[0].length), maxLength)
  }
  const head = prompt.slice(0, 512).trimStart()
  const launchContext = head.startsWith(LAUNCH_CONTEXT_HEADER)
  const preparedBrief = BRIEF_HEADER_RE.test(head)
  const roleBrief = head.startsWith('Role brief:')
  if (!launchContext && !preparedBrief && !roleBrief) {
    return prompt.slice(0, maxLength)
  }

  let content = prompt.slice(0, SESSION_PROMPT_CONTEXT_SCAN_LIMIT).trimStart()
  if (launchContext) {
    const start = content.indexOf(LAUNCH_CONTEXT_FOOTER_START)
    const end = start === -1 ? -1 : content.indexOf('\n', start + 1)
    if (end < 0 || !content.slice(start, end).trimEnd().endsWith(LAUNCH_CONTEXT_FOOTER_END)) {
      return ''
    }
    content = content.slice(end + 1).trimStart()
  }
  if (content.startsWith('Role brief:')) {
    // The shipped role profiles have their own '# Role:' heading; the next heading starts the brief.
    const roleHeader = /^Role brief:\r?\n# Role:[^\r\n]+\r?\n/.exec(content)
    const briefStart = roleHeader ? content.indexOf('\n# ', roleHeader[0].length - 1) : -1
    content = briefStart < 0 ? requestedResult(content) : content.slice(briefStart + 1)
  }
  if (BRIEF_HEADER_RE.test(content)) {
    content = requestedResult(content)
  }
  return content.slice(0, maxLength)
}
