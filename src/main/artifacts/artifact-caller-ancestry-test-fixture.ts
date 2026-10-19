import type { ProcessTableRow } from '../../shared/process-table-snapshot'

/** Process tables for the caller-ancestry and origin-caller tests. */
export const SELF = '/Applications/OmniConsole.app/Contents/MacOS/OmniConsole'
export const CLI = `${SELF} /x/out/cli/index.js artifacts share --file plan.html`
export const CLAUDE = { pid: 200, agent: 'claude' }
const BREW_PYTHON =
  '/opt/homebrew/Cellar/python@3.14/3.14.0/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python publish.py'
const XCODE_PYTHON =
  '/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python board.py'

export function row(pid: number, ppid: number, command: string): ProcessTableRow {
  return { pid, ppid, stat: 'S', command }
}

// The pane: its shell (100) runs Claude (200), whose Bash tool runs the CLI (220).
export const ROWS: ProcessTableRow[] = [
  row(90, 1, SELF),
  row(100, 90, '-zsh'),
  row(200, 100, 'claude --resume conv-1'),
  row(210, 200, '/bin/zsh -c -l omni artifacts share --file plan.html'),
  row(220, 210, CLI),
  // A child of the pane's shell, not of its agent (a runner started before Claude).
  row(400, 100, 'node scripts/watch.js'),
  row(410, 400, CLI),
  // Antigravity started from the pane's shell, still carrying the pane's environment.
  row(300, 100, '/Applications/Antigravity.app/Contents/MacOS/Electron'),
  row(320, 300, '/bin/zsh -l'),
  row(330, 320, CLI),
  // Agents and apps the pane's Claude started itself.
  row(500, 210, 'agy'),
  row(520, 500, '/bin/zsh -c omni artifacts share'),
  row(530, 520, CLI),
  row(600, 210, '/Applications/Antigravity.app/Contents/MacOS/Electron .'),
  row(
    610,
    600,
    '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (Plugin).app/Contents/MacOS/Antigravity Helper (Plugin) --type=utility'
  ),
  row(620, 610, '/bin/zsh -l'),
  row(630, 620, CLI),
  row(800, 210, 'claude -p "summarize the plan"'),
  row(810, 800, '/bin/zsh -c omni artifacts share'),
  row(820, 810, CLI),
  // Python scripts the agent runs (framework builds re-exec as Python.app).
  row(240, 210, BREW_PYTHON),
  row(250, 240, CLI),
  row(260, 210, XCODE_PYTHON),
  row(270, 260, CLI),
  // OmniConsole's own CLI process between the agent and the caller.
  row(280, 210, `${SELF} /x/out/cli/index.js run`),
  row(290, 280, CLI),
  // Reparented to launchd after the session that started it ended.
  row(900, 1, CLI),
  // Codex's npm launcher (700) runs the native codex (710), whose shell runs the CLI.
  row(700, 100, 'node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js'),
  row(710, 700, '/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex/codex'),
  row(720, 710, '/bin/zsh -c omni artifacts share'),
  row(730, 720, CLI),
  // The Agent Teams wrapper (1000) runs the real claude (1010).
  row(1000, 100, 'omni claude-teams --model opus'),
  row(1010, 1000, 'claude --model opus'),
  row(1020, 1010, '/bin/zsh -c omni artifacts share'),
  row(1030, 1020, CLI)
]
