export { screenShowsPromptMenu } from './session-prompt-screen-evidence'
import {
  buildAskAnswerKeys,
  buildCodexAskAnswerKeys,
  parseAskFromStatus
} from '../../shared/native-chat-ask'
import {
  CLAUDE_SCREEN_ALLOW_ONCE,
  CLAUDE_SCREEN_DENY,
  CODEX_SCREEN_ALLOW_ONCE,
  CODEX_SCREEN_DENY,
  describeSessionPrompt,
  freeEntryOption,
  persistentApproval,
  SCREEN_DENY_KEY,
  promptHasControlCharacters,
  promptTextIncomplete,
  type SessionPrompt,
  type SessionPromptOption
} from './session-prompt'
import { literalPromptCommand } from './session-prompt-command'
import { normalizeClaudeSingleQuestionMenu } from './session-prompt-claude-menu'

const CLAUDE_PERMISSION_FOOTER = /^Esc to cancel(?: · Tab to amend)?$/
const CODEX_PERMISSION_FOOTER = /^Press enter to confirm or esc to cancel$/i
const CLAUDE_QUESTION_FOOTER = /^Enter to select · ↑\/↓ to navigate · Esc to cancel$/
const CODEX_QUESTION_FOOTER =
  /^Enter to submit · ↑\/↓ to navigate · Tab to add notes · Esc to cancel$/
const squash = (text: string) => text.replace(/\s+/g, ' ').trim()
type ScreenPrompt = Omit<SessionPrompt, 'delivery'>

function numberedOptions(lines: string[]): SessionPromptOption[] | null {
  const options: SessionPromptOption[] = []
  let selected = 0
  for (const line of lines) {
    if (!line.trim()) {
      continue
    }
    const match = /^\s*([❯›>]?)\s*([1-9])\.\s+(.+?)\s*$/.exec(line)
    if (!match) {
      const last = options.at(-1)
      if (!last || !/^\s{4,}\S/.test(line) || /[│┌┐└┘─☐☒☑]/.test(line)) {
        return null
      }
      last.label += `\n${line.trim()}`
      continue
    }
    if (Number(match[2]) !== options.length + 1) {
      return null
    }
    if (match[1]) {
      selected += 1
    }
    options.push({ n: Number(match[2]), label: match[3]!, value: match[2]! })
  }
  return selected === 1 && options.length >= 2 ? options : null
}

function permissionOptions(agent: string, options: SessionPromptOption[]): boolean {
  for (const option of options) {
    const label = option.label
    if (persistentApproval(label)) {
      continue
    }
    if (
      (agent === 'claude' && CLAUDE_SCREEN_ALLOW_ONCE.test(label)) ||
      (agent === 'codex' && CODEX_SCREEN_ALLOW_ONCE.test(label))
    ) {
      option.role = 'allow-once'
      // The displayed Codex shortcut commits this decision directly.
      if (agent === 'codex') {
        option.value = 'y'
      }
    } else if (
      (agent === 'claude' && CLAUDE_SCREEN_DENY.test(label)) ||
      (agent === 'codex' && CODEX_SCREEN_DENY.test(label))
    ) {
      option.role = 'deny'
      option.value = SCREEN_DENY_KEY
    } else {
      return false
    }
  }
  return options.filter((option) => option.role === 'deny').length === 1
}

type HookCommand = { tool: string; summary: string }

/**
 * The agent's own report of the command it wants approved: `none` when it sent no approval
 * report. `null` when it sent one that cannot vouch for this screen (unreadable, clipped, for
 * another tool, or naming a command the screen does not show), which refuses the whole prompt,
 * as a question hook that disagrees with its screen does: the screen may be the truncated one.
 */
function approvalHookCommand(
  agent: string,
  raw: string | null | undefined,
  command: string
): HookCommand | 'none' | null {
  if (!raw) {
    return 'none'
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  const approval = (value as { approval?: unknown } | null)?.approval
  if (!approval || typeof approval !== 'object') {
    return null
  }
  const { tool, summary } = approval as { tool?: unknown; summary?: unknown }
  if (
    typeof tool !== 'string' ||
    typeof summary !== 'string' ||
    promptTextIncomplete(tool) ||
    promptTextIncomplete(summary) ||
    (agent === 'claude' && tool !== 'Bash') ||
    literalPromptCommand(command) === null ||
    literalPromptCommand(command) !== literalPromptCommand(summary)
  ) {
    return null
  }
  return { tool, summary }
}

function permissionScreen(
  agent: string,
  lines: string[],
  optionStart: number,
  options: SessionPromptOption[],
  hook: string | null | undefined
): ScreenPrompt | null {
  const footer = lines.at(-1)!.trim()
  if (
    agent === 'claude'
      ? !CLAUDE_PERMISSION_FOOTER.test(footer)
      : !CODEX_PERMISSION_FOOTER.test(footer)
  ) {
    return null
  }
  const heading =
    agent === 'claude' ? 'Bash command' : 'Would you like to run the following command?'
  const start = lines.slice(0, optionStart).findLastIndex((line) => line.trim() === heading)
  if (start === -1 || !permissionOptions(agent, options)) {
    return null
  }
  const body = lines.slice(start + 1, optionStart).filter((line) => line.trim())
  if (agent === 'claude' && body.pop()?.trim() !== 'Do you want to proceed?') {
    return null
  }
  if (!body.length || (agent === 'codex' && !body.some((line) => /^\s*\$ .+/.test(line)))) {
    return null
  }
  const command = body.join('\n').trim()
  const executable = agent === 'codex' ? command.replace(/^\s*\$ /, '') : command
  const reported = approvalHookCommand(agent, hook, executable)
  if (reported === null) {
    return null
  }
  const screenText = `${heading}\n${command}`
  const text =
    reported === 'none' ? screenText : `${reported.tool}: ${reported.summary}\n${screenText}`
  const literal = literalPromptCommand(executable)
  const commandText = reported === 'none' ? [command] : [reported.summary, command]
  if (literal !== null) {
    commandText.push(literal)
  }
  // A clipped or truncated label anywhere on the menu (a persistent one included) makes it unreadable.
  const readable =
    literal !== null &&
    !promptTextIncomplete(text) &&
    !options.some(({ label }) => promptTextIncomplete(label))
  return {
    ask: describeSessionPrompt('permission', text, options, readable, commandText),
    options,
    readable,
    subject: screenText,
    commandText
  }
}

function questionScreen(
  agent: string,
  lines: string[],
  optionStart: number,
  options: SessionPromptOption[],
  hook: string | null | undefined,
  hookBoundNativeMenu: boolean
): ScreenPrompt | null {
  const footer = lines.at(-1)!.trim()
  if (
    agent === 'claude' ? !CLAUDE_QUESTION_FOOTER.test(footer) : !CODEX_QUESTION_FOOTER.test(footer)
  ) {
    return null
  }
  const prefix = lines.slice(0, optionStart).join('\n')
  if (
    /Bash command|Do you want to proceed\?|Would you like to run the following command\?/i.test(
      prefix
    )
  ) {
    return null
  }
  if (options.some(({ label }) => /\[[ xX]\]|[☐☑☒]/.test(label))) {
    return null
  }
  // Grouped, preview and checkbox selectors have different commit semantics.
  if (/[☒☑]|\bSubmit\b|\bQuestion \d+\/|\bn to add notes\b|\bReview your answers\b/.test(prefix)) {
    return null
  }
  const question = lines
    .slice(0, optionStart)
    .findLast((line) => line.trim())
    ?.trim()
  if (
    !question ||
    (!hookBoundNativeMenu && !question.endsWith('?')) ||
    promptTextIncomplete(question)
  ) {
    return null
  }
  // A free-entry row ("Other", "Type something") opens an editor. Only a trailing one is the
  // menu's own and is set aside; anywhere else the layout is not one this parser knows.
  const trailing = options.at(-1)
  const declared = trailing && freeEntryOption(trailing.label) ? options.slice(0, -1) : options
  if (
    !declared.length ||
    declared.some((option) => promptTextIncomplete(option.label) || freeEntryOption(option.label))
  ) {
    return null
  }
  const parsedHook = parseAskFromStatus(hook)
  // Why async too: an async question has no selector, so option digits would land in the composer.
  if ((hook && !parsedHook) || parsedHook?.delivery === 'async') {
    return null
  }
  if (parsedHook) {
    const q = parsedHook.questions[0]
    if (
      parsedHook.questions.length !== 1 ||
      !q ||
      q.multiSelect ||
      q.options.some((option) => option.preview)
    ) {
      return null
    }
    if (squash(q.question) !== squash(question) || q.options.length !== declared.length) {
      return null
    }
    if (
      q.header &&
      (promptTextIncomplete(q.header) ||
        !lines.slice(0, optionStart).some((line) => squash(line) === squash(q.header!)))
    ) {
      return null
    }
    if (
      q.options.some(
        (option, index) =>
          squash([option.label, option.description].filter(Boolean).join(' ')) !==
          squash(declared[index]!.label)
      )
    ) {
      return null
    }
  }
  const prompt = parsedHook ?? {
    questions: [{ question, multiSelect: false, options: declared.map(({ label }) => ({ label })) }]
  }
  const buildKeys = agent === 'claude' ? buildAskAnswerKeys : buildCodexAskAnswerKeys
  for (const option of declared) {
    const keys = buildKeys(prompt, [{ indices: [option.n - 1] }])
    const key = keys.length === 1 && 'raw' in keys[0]! ? keys[0]!.raw : ''
    // Exactly the option's own digit, or no value at all: an option without one is never chosen.
    option.value = /^[1-9]$/.test(key) && key === String(option.n) ? key : ''
  }
  const readable = !promptTextIncomplete(prefix)
  const header = parsedHook?.questions[0]?.header
  const commandText = header ? [header] : []
  return {
    ask: describeSessionPrompt('question', prefix.trim(), declared, readable, commandText),
    options: declared,
    readable,
    subject: question,
    commandText
  }
}

export function parseSessionPromptScreen(
  agent: string,
  screen: string,
  hook?: string | null
): ScreenPrompt | null {
  if (agent !== 'claude' && agent !== 'codex') {
    return null
  }
  if (promptHasControlCharacters(screen)) {
    return null
  }
  const rawLines = screen.replace(/\r/g, '').trimEnd().split('\n')
  const nativeMenu = agent === 'claude' ? normalizeClaudeSingleQuestionMenu(rawLines, hook) : null
  const lines = nativeMenu ?? rawLines
  const optionStart = lines.findIndex((line) => /^\s*[❯›>]?\s*1\.\s/.test(line))
  if (optionStart === -1) {
    return null
  }
  const options = numberedOptions(lines.slice(optionStart, -1))
  if (!options) {
    return null
  }
  return (
    permissionScreen(agent, lines, optionStart, options, hook) ??
    questionScreen(agent, lines, optionStart, options, hook, nativeMenu !== null)
  )
}
