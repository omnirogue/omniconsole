/**
 * `/next …` — the Prompt Queue without the mouse.
 *
 * One grammar, read in exactly one place, used by the terminal pane, the chat
 * composer and the `omni prompt-queue` CLI so the three cannot drift:
 *
 *   /next <prompt>      queue this prompt for this conversation
 *   /next               show what is queued for this conversation
 *   /queue              show what is queued for this conversation
 *   /queue list         the same
 *   /queue add <prompt> queue this prompt
 *   /queue clear        forget the prompts still waiting
 *
 * The command must start at column 0. A line that merely CONTAINS `/next` is an
 * ordinary line and is never touched — `echo /next` still echoes.
 *
 * This file holds no side effects and no i18n: it turns a line into an intent,
 * and the callers own the doors and the words.
 */

export type PromptQueueCommand =
  | { kind: 'add'; text: string }
  | { kind: 'list' }
  | { kind: 'clear' }

/** How wide a prompt is shown when the queue is listed back to the person. */
export const PROMPT_QUEUE_COMMAND_PREVIEW_LENGTH = 60

/**
 * The intent in this line, or null when the line is not one of these commands.
 *
 * Null is the important answer: it means "this is the person's own input", and
 * every caller forwards it untouched.
 */
export function parsePromptQueueCommand(line: string): PromptQueueCommand | null {
  // Why the trailing-only trim: a leading space means the person did not type the
  // command at column 0, and `  /next x` is a line for the shell, not for us.
  // A NUL is what a terminal pads a line with; never spell it inside a regex (no-control-regex).
  const NUL = String.fromCharCode(0)
  let end = line.length
  while (end > 0 && (line[end - 1] === NUL || /\s/u.test(line[end - 1]!))) {
    end -= 1
  }
  const typed = line.slice(0, end)
  if (typed === '/next' || typed === '/queue' || typed === '/queue list') {
    return { kind: 'list' }
  }
  if (typed === '/queue clear') {
    return { kind: 'clear' }
  }
  const next = commandArgument(typed, '/next')
  if (next !== null) {
    return next.trim() ? { kind: 'add', text: next.trim() } : { kind: 'list' }
  }
  const queued = commandArgument(typed, '/queue add')
  if (queued !== null && queued.trim()) {
    return { kind: 'add', text: queued.trim() }
  }
  return null
}

/** The text after `<command> ` — null when the line is not that command at all. */
function commandArgument(line: string, command: string): string | null {
  return line.startsWith(`${command} `) ? line.slice(command.length + 1) : null
}

/** One line of the person's own prompt, cut to a width a terminal row can hold. */
export function promptQueueCommandPreview(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? ''
  return line.length > PROMPT_QUEUE_COMMAND_PREVIEW_LENGTH
    ? `${line.slice(0, PROMPT_QUEUE_COMMAND_PREVIEW_LENGTH - 1)}…`
    : line
}

/**
 * What the person has typed on the current terminal line, as far as it can be
 * TRUSTED to be that and nothing else.
 *
 * A terminal has no lines, only bytes. This reconstructs the one thing `/next`
 * needs — "the line typed since the last Enter, made only of plain characters and
 * backspaces" — and gives up (`trusted: false`) the moment anything else arrives:
 * an arrow key, a paste bracket, Ctrl+anything, a resize reply. Giving up means
 * the input is forwarded as it always was; it never means guessing.
 *
 * Three kinds of chunk arrive here, and telling them apart is the whole job:
 *  - the person's own characters and backspaces — the line;
 *  - the EMULATOR's own reports (a focus change, a mouse report): they must reach
 *    the PTY, because the application asked for them, but they say nothing about
 *    the line and so must not make it unreadable;
 *  - anything else — the line is no longer knowable, so give up.
 */
export type TypedTerminalLine = { chars: string[]; trusted: boolean }

export function emptyTypedTerminalLine(): TypedTerminalLine {
  return { chars: [], trusted: true }
}

const BACKSPACES = new Set(['\x7f', '\b'])
// eslint-disable-next-line no-control-regex -- the point is exactly which control bytes are plain text
const PLAIN_TEXT = /^[^\x00-\x1f\x7f]+$/u
/**
 * Every encoding of "the person pressed Enter, alone".
 *
 * `\x1b[13u` / `\x1b[13;1u` are the kitty-keyboard forms an agent CLI negotiates
 * (the same set the answered-question inference reads in
 * `shared/agent-question-answered-intent.ts`). A MODIFIED Enter is deliberately
 * absent: Shift+Enter is a newline inside the agent's own box, not a submit.
 */
const ENTER_INPUTS: ReadonlySet<string> = new Set(['\r', '\n', '\r\n', '\x1b[13u', '\x1b[13;1u'])
/* oxlint-disable no-control-regex -- these grammars ARE terminal control sequences; they are
   built via new RegExp from \u escapes so no literal control character appears in the source. */
/**
 * Reports xterm itself puts on this stream: focus in/out (DEC private mode 1004,
 * which every agent CLI turns on) and mouse reports (X10 `CSI M` + 3 bytes and
 * SGR `CSI < b;x;y M|m`, the same grammar the link-click suppression reads).
 *
 * Why they are singled out: clicking or revealing a pane makes xterm emit a focus
 * report on the input stream, which used to mark the line unreadable for good —
 * so a `/next` typed after any click fell through to the agent as text
 * ("Unknown command: /next"). Consecutive reports can arrive coalesced in one
 * chunk, hence the `+`.
 */
const EMULATOR_REPORTS_RE = new RegExp(
  '^(?:\\u001b\\[[IO]|\\u001b\\[M[\\s\\S]{3}|\\u001b\\[<[0-9]+;[0-9]+;[0-9]+[Mm])+$'
)

export function isTerminalEmulatorReport(data: string): boolean {
  return EMULATOR_REPORTS_RE.test(data)
}
/**
 * A whole line AND its Enter in a single write.
 *
 * The accessible "Terminal input" delivers a value that way (one
 * `terminal.input()` call), as does an IME commit that ends with the Enter. The
 * characters have not reached the PTY yet, so this shape carries its own erase
 * width of zero.
 */
const WHOLE_LINE_RE = new RegExp('^([^\\u0000-\\u001f\\u007f]+)(?:\\r\\n|\\r|\\n)$', 'u')
/* oxlint-enable no-control-regex */

export type TypedTerminalLineObservation = {
  state: TypedTerminalLine
  /** Set only on Enter, and only when the whole line was typed plainly. */
  committed: string | null
  /** How many characters of `committed` the agent's own input box already holds. */
  echoed: number
}

export function observeTypedTerminalInput(
  state: TypedTerminalLine,
  data: string
): TypedTerminalLineObservation {
  if (isTerminalEmulatorReport(data)) {
    return { state, committed: null, echoed: 0 }
  }
  if (ENTER_INPUTS.has(data)) {
    return {
      state: emptyTypedTerminalLine(),
      committed: state.trusted && state.chars.length ? state.chars.join('') : null,
      echoed: state.chars.length
    }
  }
  const whole = state.trusted ? WHOLE_LINE_RE.exec(data) : null
  if (whole?.[1]) {
    return {
      state: emptyTypedTerminalLine(),
      committed: state.chars.join('') + whole[1],
      echoed: state.chars.length
    }
  }
  if (BACKSPACES.has(data)) {
    return {
      state: { chars: state.chars.slice(0, -1), trusted: state.trusted },
      committed: null,
      echoed: 0
    }
  }
  if (PLAIN_TEXT.test(data)) {
    // Why code points and not UTF-16 units: the erase below sends one backspace per
    // character the person typed, and an emoji is one character to every line editor.
    return {
      state: { chars: [...state.chars, ...Array.from(data)], trusted: state.trusted },
      committed: null,
      echoed: 0
    }
  }
  return { state: { chars: state.chars, trusted: false }, committed: null, echoed: 0 }
}

/**
 * How many backspaces undo the part of the command line the agent already has.
 *
 * Characters typed one by one reached the agent as they were typed — that is what a
 * terminal is. Swallowing the Enter keeps them from being SUBMITTED, and this many
 * backspaces take them back out of the agent's own input box. A line written in one
 * go never reached it, so its count is zero and nothing is taken back.
 */
export function promptQueueCommandErase(echoed: number): string {
  return '\x7f'.repeat(Math.max(0, echoed))
}
