import { translate } from '@/i18n/i18n'
import type { LocalWorkflowRoute } from '../../../../shared/local-workflow-seats'

/**
 * One readable step of an agent's captured output: a tool it used, a message it wrote, its
 * reasoning, or something that went wrong (a refused tool, a provider error).
 */
export type WorkflowActivityEntry = {
  /** 1-based step number, stable for a given capture. */
  step: number
  kind: 'tool' | 'message' | 'thinking' | 'problem'
  text: string
}

type Draft = Omit<WorkflowActivityEntry, 'step'>

type Line = Record<string, unknown>
type Collect = {
  add: (kind: WorkflowActivityEntry['kind'], text: string | undefined) => void
  /** Streamed chunks of one message or thought, joined into a single step. */
  stream: (kind: 'message' | 'thinking', chunk: string | undefined) => void
}

const TOOL_TEXT_LIMIT = 160

function record(value: unknown): Line | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Line) : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function clip(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim()
  return single.length > TOOL_TEXT_LIMIT ? `${single.slice(0, TOOL_TEXT_LIMIT - 1)}…` : single
}

/** `/bin/zsh -lc "rg foo src"` reads as `rg foo src`. */
function shellCommand(command: string): string {
  const wrapped = /^\S*\/(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim())
  return (wrapped ? wrapped[2] : command).trim()
}

/** "Read src/app.ts", "Searched for retry": one line per tool call, in the reader's language. */
export function workflowToolStep(name: string, input: Line | undefined): string {
  const path =
    text(input?.file_path) ??
    text(input?.target_file) ??
    text(input?.path) ??
    text(input?.dir_path) ??
    text(input?.target_directory)
  const pattern = text(input?.pattern) ?? text(input?.query)
  const command = text(input?.command)
  switch (name.toLowerCase()) {
    case 'read':
    case 'read_file':
      return clip(
        path
          ? translate('localWorkflow.activity.read', 'Read {{path}}', { path })
          : translate('localWorkflow.activity.readFiles', 'Read files')
      )
    case 'grep':
    case 'grep_search':
    case 'search_file_content':
      return clip(
        pattern
          ? translate('localWorkflow.activity.searched', 'Searched for {{pattern}}', { pattern })
          : translate('localWorkflow.activity.searchedCode', 'Searched the code')
      )
    case 'glob':
      return clip(
        pattern
          ? translate('localWorkflow.activity.found', 'Looked for files matching {{pattern}}', {
              pattern
            })
          : translate('localWorkflow.activity.foundFiles', 'Looked for files')
      )
    case 'ls':
    case 'list_dir':
    case 'list_directory':
      return clip(
        path
          ? translate('localWorkflow.activity.listed', 'Listed {{path}}', { path })
          : translate('localWorkflow.activity.listedFiles', 'Listed files')
      )
    case 'bash':
    case 'shell':
    case 'run_shell_command':
      return clip(
        command
          ? translate('localWorkflow.activity.ran', 'Ran {{command}}', {
              command: shellCommand(command)
            })
          : translate('localWorkflow.activity.ranCommand', 'Ran a command')
      )
    default:
      return clip(translate('localWorkflow.activity.used', 'Used {{tool}}', { tool: name }))
  }
}

function claudeLine(line: Line, collect: Collect): void {
  if (line.type === 'assistant') {
    const content = record(line.message)?.content
    for (const block of Array.isArray(content) ? content : []) {
      const entry = record(block)
      if (entry?.type === 'text') {
        collect.add('message', text(entry.text))
      } else if (entry?.type === 'thinking') {
        collect.add('thinking', text(entry.thinking))
      } else if (entry?.type === 'tool_use' && entry.name !== 'StructuredOutput') {
        collect.add('tool', workflowToolStep(text(entry.name) ?? 'tool', record(entry.input)))
      } else if (entry?.type === 'tool_use') {
        collect.add('message', translate('localWorkflow.activity.wroteAnswer', 'Wrote the answer'))
      }
    }
  } else if (line.type === 'system' && line.subtype === 'permission_denied') {
    collect.add(
      'problem',
      translate('localWorkflow.activity.refused', 'Not allowed to use {{tool}} (read-only)', {
        tool: text(line.tool_name) ?? translate('localWorkflow.activity.aTool', 'a tool')
      })
    )
  } else if (line.type === 'result' && (line.is_error === true || line.subtype !== 'success')) {
    collect.add('problem', text(line.result) ?? text(line.error) ?? text(line.subtype))
  }
}

function codexLine(line: Line, collect: Collect): void {
  const item = record(line.item)
  if (line.type === 'item.started' && item?.type === 'command_execution') {
    collect.add('tool', workflowToolStep('shell', { command: item.command }))
  } else if (line.type === 'item.completed' && item?.type === 'agent_message') {
    collect.add('message', text(item.text))
  } else if (line.type === 'item.completed' && item?.type === 'reasoning') {
    collect.add('thinking', text(item.text))
  } else if (line.type === 'item.completed' && item?.type === 'mcp_tool_call') {
    collect.add('tool', workflowToolStep(text(item.tool) ?? 'tool', record(item.arguments)))
  } else if (line.type === 'error') {
    collect.add('problem', text(line.message))
  } else if (line.type === 'turn.failed') {
    collect.add('problem', text(record(line.error)?.message))
  }
}

function grokLine(line: Line, collect: Collect): void {
  if (line.type === 'text') {
    collect.stream('message', typeof line.data === 'string' ? line.data : undefined)
  } else if (line.type === 'thought') {
    collect.stream('thinking', typeof line.data === 'string' ? line.data : undefined)
  } else if (line.type === 'tool_call') {
    const name = text(line.toolName) ?? text(line.title) ?? 'tool'
    collect.add('tool', workflowToolStep(name, record(line.rawInput)))
  } else if (line.type === 'error') {
    collect.add('problem', text(line.message) ?? text(line.data))
  }
}

function geminiLine(line: Line, collect: Collect): void {
  if (line.type === 'message' && line.role === 'assistant') {
    collect.stream('message', typeof line.content === 'string' ? line.content : undefined)
  } else if (line.type === 'tool_use') {
    collect.add('tool', workflowToolStep(text(line.tool_name) ?? 'tool', record(line.parameters)))
  } else if (line.type === 'error' || (line.type === 'result' && line.status === 'error')) {
    collect.add('problem', text(line.message) ?? text(record(line.error)?.message))
  }
}

/** The OpenRouter and Ollama workers emit the same lines. */
function workerLine(line: Line, collect: Collect): void {
  if (line.type === 'result') {
    collect.stream('message', text(line.text))
  }
  if (line.type === 'tool') {
    collect.add('tool', text(line.name))
  }
  if (line.type === 'error') {
    collect.add('problem', text(line.message))
  }
}

const READERS: Record<LocalWorkflowRoute, (line: Line, collect: Collect) => void> = {
  claude: claudeLine,
  codex: codexLine,
  grok: grokLine,
  openrouter: workerLine,
  ollama: workerLine,
  gemini: geminiLine
}

/**
 * Turns one agent's streamed JSON output into the steps a person can read: tools, messages,
 * reasoning and problems. Per-token events and bookkeeping lines are dropped. Output that is not
 * one JSON object per line (older envelopes, plain text) yields nothing, and the raw text shows.
 */
export function workflowCallActivity(
  route: LocalWorkflowRoute | undefined,
  stdout: string
): WorkflowActivityEntry[] {
  const reader = route ? READERS[route] : undefined
  if (!reader) {
    return []
  }
  const entries: Draft[] = []
  let streaming: Draft | undefined
  const collect: Collect = {
    add: (kind, value) => {
      streaming = undefined
      if (value?.trim()) {
        entries.push({ kind, text: value.trim() })
      }
    },
    stream: (kind, chunk) => {
      if (!chunk) {
        return
      }
      if (streaming?.kind === kind) {
        streaming.text += chunk
        return
      }
      streaming = { kind, text: chunk }
      entries.push(streaming)
    }
  }
  for (const raw of stdout.split('\n')) {
    if (!raw.trimStart().startsWith('{')) {
      continue
    }
    try {
      const line = record(JSON.parse(raw))
      if (line) {
        reader(line, collect)
      }
    } catch {
      // A torn or truncated line is only missing from the readable view; Raw output keeps it.
    }
  }
  return entries
    .map((entry) => ({ ...entry, text: entry.text.trim() }))
    .filter((entry) => entry.text)
    .map((entry, index) => ({ step: index + 1, ...entry }))
}
