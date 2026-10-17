#!/usr/bin/env node

// A session-management fixture must prove an agent command, never just an old hook PID.
const claudeTitle = process.env.GOLDEN_STUB_AGENT_TITLE === 'claude'
// The real agent exposes idle in its terminal title; a Stop hook alone is not idle proof.
const CLAUDE_IDLE_TITLE = '\x1b]0;✳ Claude Code\x07'
if (claudeTitle) {
  process.title = 'claude'
  process.stdout.write(CLAUDE_IDLE_TITLE)
}

const READY_MARKER = 'GOLDEN_STUB_AGENT_READY'
const EXIT_MARKER = 'GOLDEN_STUB_AGENT_EXITED'

const ESC = '\x1b'
const keyboardProtocolMode = process.argv.includes('--keyboard-protocol')
const nativeQuestion = process.env.GOLDEN_STUB_QUESTION_CONTROL
  ? require('./native-question-mode.cjs')(process.env.GOLDEN_STUB_QUESTION_CONTROL)
  : null
// Both match the bytes after ESC, so the control character stays out of the
// pattern: a CSI/SS3 introducer still missing its final byte, and a complete
// CSI/SS3 sequence. Shift+Enter is matched before either is consulted.
const INCOMPLETE_ESCAPE_TAIL_RE = /^(?:\[[0-9;?]*|O)?$/
const ESCAPE_TAIL_RE = /^(?:\[[0-9;?]*[ -/]*[@-~]|O[@-~])/

let composer = ''
let lastSubmission = ''
// Opt-in: every submission stays on screen as one short receipt line, so no redraw can hide a send.
const receiptsMode = process.env.GOLDEN_STUB_RECEIPTS === '1'
const receipts = []

/** A Keep going round (`KG1/10`) and any `tok-…` tokens; else the prompt's first 40 characters. */
function receiptOf(text) {
  const round = /^\[Keep going (\d+\/\d+)/.exec(text)
  const tokens = text.match(/\btok-[A-Za-z0-9-]+/g) ?? []
  const short = [...(round ? [`KG${round[1]}`] : []), ...tokens].join(' ')
  return short || text.replace(/\s+/g, ' ').trim().slice(0, 40)
}
let pendingInput = ''
let exiting = false

// Startup screens captured from the real CLIs on 2026-09-13. While one is
// showing, the composer is covered and the next resolving key answers the
// menu — exactly the bytes a chat prompt would otherwise become.
const STARTUP_SCREENS = {
  'codex-update': [
    '╭─────────────────────────────────────────╮',
    '│ >_ OpenAI Codex (v0.153.0)              │',
    '│ model:       loading   /model to change │',
    '│ permissions: YOLO mode                  │',
    '╰─────────────────────────────────────────╯',
    '  › Ask Codex to do anything   ? for shortcuts',
    '',
    '  ✨ Update available!',
    '  0.153.0 -> 0.154.0',
    '  Release notes: https://github.com/openai/codex/releases/latest',
    '  › 1. Update now (runs `npm install -g @openai/codex`)',
    '    2. Skip',
    '    3. Skip until next version',
    '  Press enter to continue'
  ],
  'codex-trust': [
    '> You are in /tmp/untrusted',
    'Do you trust the contents of this directory?',
    'Working with untrusted contents comes with higher risk of prompt injection.',
    '› 1. Yes, continue',
    '  2. No, quit',
    'Press enter to continue'
  ],
  'claude-trust': [
    'Accessing workspace:',
    '/tmp/untrusted',
    'Quick safety check: Is this a project you created or one you trust?',
    "Claude Code'll be able to read, edit, and execute files here.",
    '❯ No, exit',
    '  Yes, I trust this folder',
    'Enter to confirm · Esc to cancel'
  ]
}
let startupScreen = STARTUP_SCREENS[process.env.GOLDEN_STUB_STARTUP]
  ? process.env.GOLDEN_STUB_STARTUP
  : null
let startupAnswer = ''
const startupLog = []
let claudeTrustHighlight = 'no'
let startupAnswered = ''

function renderStartupScreen() {
  process.stdout.write(
    `\x1b]0;Golden Stub Agent\x07\x1b[?2004h${['\x1b[H\x1b[2J', ...STARTUP_SCREENS[startupScreen]].join('\r\n')}`
  )
}

function exitAfterUpdate() {
  process.stdout.write(
    '\r\nUpdating Codex via `npm install -g @openai/codex`...\r\n\r\nchanged 2 packages in 2s\r\n\r\n🎉 Update ran successfully! Please restart Codex.\r\n'
  )
  exiting = true
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
  }
  process.stdout.write('\x1b[?1049l[GOLDEN_STUB_AGENT_UPDATED_AND_EXITED]\r\n', () =>
    process.exit(0)
  )
}

/** Consume bytes while a startup screen is up. Returns true when it swallowed the chunk. */
function consumeStartupInput() {
  if (!startupScreen) {
    return false
  }
  while (pendingInput.length > 0) {
    const char = pendingInput[0]
    pendingInput = pendingInput.slice(1)
    startupLog.push(JSON.stringify(char))
    if (startupScreen === 'claude-trust') {
      if (pendingInput.startsWith('[B') && char === ESC) {
        pendingInput = pendingInput.slice(2)
        claudeTrustHighlight = 'yes'
        continue
      }
      if (char === ESC) {
        exitCleanly()
        return true
      }
      if (char === '\r' || char === '\n') {
        if (claudeTrustHighlight === 'no') {
          exitCleanly()
          return true
        }
        startupScreen = null
        startupAnswered = `[GOLDEN_STUB_STARTUP_ANSWERED ${startupLog.join(' ')}]`
        render()
        return true
      }
      continue
    }
    if (/[1-3]/.test(char)) {
      startupAnswer = char
      continue
    }
    if (char === '\r' || char === '\n') {
      const answer = startupAnswer || '1'
      startupAnswer = ''
      startupAnswered = `[GOLDEN_STUB_STARTUP_ANSWERED ${startupLog.join(' ')}]`
      if (startupScreen === 'codex-update' && answer === '1') {
        exitAfterUpdate()
        return true
      }
      if (startupScreen === 'codex-trust' && answer === '2') {
        exitCleanly()
        return true
      }
      startupScreen = null
      render()
      return true
    }
    // Why: any other byte (a pasted prompt, Ctrl+U) is swallowed by the menu, as the real TUIs do.
  }
  return true
}

function composerTitle() {
  if (keyboardProtocolMode) {
    return '\x1b]0;\u280b Codex is thinking\x07\x1b[>1u'
  }
  // Why: every repaint sets the title, so the Claude fixture repaints its idle title too; the one
  // written at startup would otherwise be replaced before any reading could show the pane idle.
  return claudeTitle ? CLAUDE_IDLE_TITLE : '\x1b]0;Golden Stub Agent\x07'
}

function render() {
  if (nativeQuestion) {
    nativeQuestion.render()
    return
  }
  const lines = composer.split('\n')
  const renderedComposer = lines.map((line, index) => `${index === 0 ? '> ' : '  '}${line}`)
  process.stdout.write(
    `${composerTitle()}${[
      '\x1b[H\x1b[2JGolden Stub Agent',
      `[${READY_MARKER}]`,
      // Opt-in: the pid a test's simulated hooks report as the agent process (`agentPid`).
      ...(process.env.GOLDEN_STUB_SHOW_PID === '1'
        ? [`[GOLDEN_STUB_AGENT_PID] ${process.pid}`]
        : []),
      '',
      ...renderedComposer,
      '',
      'Shift+Enter inserts a newline. Type exit then Enter to quit.',
      ...(lastSubmission ? [`[GOLDEN_STUB_AGENT_SUBMITTED] ${lastSubmission}`] : []),
      ...receipts.map((receipt, at) => `RECEIPT ${at + 1}: ${receipt}`),
      // Why on the composer screen: render() clears the alternate screen, so the
      // answer trail must be part of it to stay readable to the test.
      ...(startupAnswered ? [startupAnswered] : [])
    ].join('\r\n')}`
  )
}

function exitCleanly() {
  if (exiting) {
    return
  }
  exiting = true
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
  }
  const idleTitle = keyboardProtocolMode ? '\x1b]0;Codex\x07' : ''
  process.stdout.write(`${idleTitle}\x1b[?1049l[${EXIT_MARKER}]\r\n`, () => process.exit(0))
}

function submit() {
  if (composer.trim() === 'title-cycle') {
    composer = ''
    const title =
      process.env.GOLDEN_STUB_TITLE_AGENT === 'claude' ? '✳ Claude Code' : '⠋ Codex is thinking'
    process.stdout.write(`\x1b]0;${title}\x07`)
    setTimeout(() => {
      // A child shell can change the title without ending the provider process.
      process.stdout.write('\x1b]0;zsh\x07\r\n[GOLDEN_STUB_TITLE_CHANGED_STILL_RUNNING]\r\n')
    }, 500)
    return
  }
  if (composer.trim() === 'exit') {
    exitCleanly()
    return
  }
  lastSubmission = composer
  if (receiptsMode) {
    receipts.push(receiptOf(composer))
  }
  composer = ''
  render()
}

function consumeInput() {
  if (nativeQuestion) {
    nativeQuestion.consume(pendingInput)
    pendingInput = ''
    return
  }
  while (pendingInput.length > 0 && !exiting) {
    const enter = ['\x1b[13u', '\x1b[13;1u'].find((sequence) => pendingInput.startsWith(sequence))
    if (enter) {
      pendingInput = pendingInput.slice(enter.length)
      submit()
      continue
    }
    const shiftEnter = ['\x1b[13;2u', '\x1b[13;2~', '\x1b\r'].find((sequence) =>
      pendingInput.startsWith(sequence)
    )
    if (shiftEnter) {
      pendingInput = pendingInput.slice(shiftEnter.length)
      composer += '\n'
      render()
      continue
    }
    if (pendingInput.startsWith(ESC)) {
      const tail = pendingInput.slice(ESC.length)
      // Wait for the rest of a sequence that is still arriving.
      if (INCOMPLETE_ESCAPE_TAIL_RE.test(tail)) {
        return
      }
      // Why: without this, an unhandled sequence loses its ESC to the sub-space
      // filter below and types its tail ("[A") into the composer, so a stray key
      // report surfaces as a baffling render diff instead of being ignored.
      const escape = ESCAPE_TAIL_RE.exec(tail)
      if (escape) {
        pendingInput = pendingInput.slice(ESC.length + escape[0].length)
        continue
      }
    }

    const char = pendingInput[0]
    pendingInput = pendingInput.slice(1)
    if (char === '\r' || char === '\n') {
      submit()
    } else if (char === '\x04' || char === '\x03') {
      // Raw mode delivers Ctrl+C as \x03 instead of raising SIGINT.
      exitCleanly()
    } else if (char === '\x7f' || char === '\b') {
      composer = composer.slice(0, -1)
      render()
    } else if (char >= ' ') {
      composer += char
      render()
    }
  }
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  pendingInput += typeof chunk === 'string' ? chunk : chunk.toString()
  if (consumeStartupInput()) {
    return
  }
  consumeInput()
})
process.stdin.resume()

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, exitCleanly)
}

process.stdout.write('\x1b[?1049h')
if (startupScreen) {
  // Why: the real CLIs draw the composer first and the menu ~1s later, which is the
  // window the audited send fell into.
  render()
  setTimeout(renderStartupScreen, Number(process.env.GOLDEN_STUB_STARTUP_DELAY_MS ?? 800))
} else {
  render()
}
