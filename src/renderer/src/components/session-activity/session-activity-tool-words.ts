// What a running tool call means in plain words ("Running gh run view", "Editing App.tsx"),
// so a status line never shows a raw shell pipeline. Unknown tools return null and keep the
// literal "Tool · input" line.

import { translate } from '@/i18n/i18n'
import { isAgentTodoToolName } from '../../../../shared/agent-todo-list'

const SHELL_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'shell',
  'exec_command',
  'local_shell',
  'powershell'
])
const READ_TOOLS: ReadonlySet<string> = new Set(['read', 'read_file', 'view', 'ls'])
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'multiedit',
  'str_replace',
  'str_replace_editor',
  'apply_patch',
  'notebookedit'
])
const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'write_file', 'create_file'])
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['grep', 'glob', 'search', 'rg'])
const HELPER_TOOLS: ReadonlySet<string> = new Set(['task', 'agent'])
/** Words that only set up the command that follows them. */
const PREFIX_COMMANDS: ReadonlySet<string> = new Set(['sudo', 'env', 'time', 'nohup', 'exec'])
const SETUP_COMMANDS: ReadonlySet<string> = new Set(['cd', 'export', 'set', 'source', '.'])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SUBCOMMAND_WORD = /^[a-z][a-z0-9:_-]*$/

function lastPathPart(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || trimmed
}

/** A single path argument's file name, or null when the input is not one path. */
function fileNameOf(input: string): string | null {
  const text = input.trim()
  return text && !/\s/.test(text) ? lastPathPart(text) : null
}

/**
 * The first real command a shell line runs, as "program sub sub":
 * `cd x && gh run view 123 --log | python3 …` → "gh run view".
 */
export function shellCommandWords(command: string): string | null {
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    while (tokens[0] && (ENV_ASSIGNMENT.test(tokens[0]) || PREFIX_COMMANDS.has(tokens[0]))) {
      tokens.shift()
    }
    const program = tokens[0]
    if (!program || SETUP_COMMANDS.has(program)) {
      continue
    }
    const words = [lastPathPart(program)]
    for (const token of tokens.slice(1, 3)) {
      if (!SUBCOMMAND_WORD.test(token)) {
        break
      }
      words.push(token)
    }
    return words.join(' ')
  }
  return null
}

function siteOf(input: string): string | null {
  try {
    return new URL(input.trim()).hostname || null
  } catch {
    return null
  }
}

/** The plain-words line for a running tool, or null when the tool has no known meaning. */
export function plainToolActivity(tool: string, input: string | undefined): string | null {
  const name = tool.trim()
  const lower = name.toLowerCase()
  const detail = input?.trim() ?? ''
  if (SHELL_TOOLS.has(lower)) {
    const command = detail ? shellCommandWords(detail) : null
    return command
      ? translate('sessionActivity.plainShell', 'Running {{command}}', { command })
      : null
  }
  if (READ_TOOLS.has(lower)) {
    const file = fileNameOf(detail)
    return file
      ? translate('sessionActivity.plainRead', 'Reading {{file}}', { file })
      : translate('sessionActivity.plainReadAny', 'Reading files')
  }
  if (EDIT_TOOLS.has(lower)) {
    const file = fileNameOf(detail)
    return file
      ? translate('sessionActivity.plainEdit', 'Editing {{file}}', { file })
      : translate('sessionActivity.plainEditAny', 'Editing files')
  }
  if (WRITE_TOOLS.has(lower)) {
    const file = fileNameOf(detail)
    return file
      ? translate('sessionActivity.plainWrite', 'Writing {{file}}', { file })
      : translate('sessionActivity.plainEditAny', 'Editing files')
  }
  if (SEARCH_TOOLS.has(lower)) {
    return translate('sessionActivity.plainSearch', 'Searching the code')
  }
  if (lower === 'webfetch' || lower === 'web_fetch') {
    const site = siteOf(detail)
    return site
      ? translate('sessionActivity.plainFetch', 'Reading {{site}}', { site })
      : translate('sessionActivity.plainFetchAny', 'Reading a web page')
  }
  if (lower === 'websearch' || lower === 'web_search') {
    return translate('sessionActivity.plainWebSearch', 'Searching the web')
  }
  if (HELPER_TOOLS.has(lower)) {
    return translate('sessionActivity.plainHelper', 'Working with a helper agent')
  }
  if (isAgentTodoToolName(name)) {
    return translate('sessionActivity.plainTodos', 'Updating its to-do list')
  }
  const server = /^mcp__(.+?)__/.exec(name)?.[1]
  return server ? translate('sessionActivity.plainMcp', 'Using {{server}}', { server }) : null
}
