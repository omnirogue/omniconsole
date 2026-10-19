import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { _internals } from '../agent-hooks/server'
import { buildBody } from '../agent-hooks/server.test-fixtures'
import {
  isEndingHook,
  mapHookToLedgerEvents,
  shellCommandTarget,
  stopReasonForTeardown,
  writeTargetPath
} from './ledger-lifecycle'
import { publishablePath } from './ledger-path-privacy'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

const publishPath = (rawPath: string): string => publishablePath(rawPath)

/** Runs a raw provider hook body through the real normalizer, then the ledger mapping. */
function ledgerEventsFor(source: AgentHookSource, payload: Record<string, unknown>) {
  const normalized = _internals.normalizeHookPayload(source, buildBody(payload), 'production')
  if (!normalized) {
    throw new Error(`${source} normalizer dropped ${String(payload.hook_event_name)}`)
  }
  return mapHookToLedgerEvents(
    {
      hookEventName: normalized.hookEventName,
      toolName: normalized.payload.toolName,
      toolInput: normalized.payload.toolInput,
      toolAgentType: normalized.toolAgentType
    },
    { publishPath }
  )
}

beforeEach(() => {
  _internals.resetCachesForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Claude lifecycle → ledger events', () => {
  it('maps edits, shell calls, subagents and the turn end', () => {
    ledgerEventsFor('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'do it' })
    expect(
      ledgerEventsFor('claude', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '/Users/maintainer/repo/src/a.ts', old_string: 'x', new_string: 'y' }
      })
    ).toEqual([{ kind: 'file_write', detail: { path: '~/repo/src/a.ts', op: 'edit' } }])
    expect(
      ledgerEventsFor('claude', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/Users/maintainer/repo/new.ts', content: 'secret body' }
      })
    ).toEqual([{ kind: 'file_write', detail: { path: '~/repo/new.ts', op: 'create' } }])
    expect(
      ledgerEventsFor('claude', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "private message"' }
      })
    ).toEqual([{ kind: 'tool_call', detail: { tool: 'bash', target: 'git' } }])
    expect(
      ledgerEventsFor('claude', {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: {}
      })
    ).toEqual([])
    expect(
      ledgerEventsFor('claude', {
        hook_event_name: 'SubagentStop',
        agent_id: 'a-1',
        agent_type: 'general-purpose'
      })
    ).toEqual([{ kind: 'tool_call', detail: { tool: 'subagent', target: 'general-purpose' } }])
    expect(ledgerEventsFor('claude', { hook_event_name: 'Stop' })).toEqual([
      { kind: 'stop', detail: { reason: 'turn_end' } }
    ])
  })

  it('never sees a Claude SessionEnd: the normalizer drops it, so /clear cannot end the row', () => {
    // Why: Claude's SessionEnd (reason clear|logout|prompt_input_exit|other) yields no status
    // row (claude-events.ts reportedStateName === null); the PTY exit teardown owns `exit`.
    for (const reason of ['clear', 'logout', 'prompt_input_exit', 'other']) {
      expect(() => ledgerEventsFor('claude', { hook_event_name: 'SessionEnd', reason })).toThrow(
        /dropped SessionEnd/
      )
    }
    // A /clear's SessionStart{source: clear} reaches the ledger as no event: the attempt continues.
    expect(ledgerEventsFor('claude', { hook_event_name: 'SessionStart', source: 'clear' })).toEqual(
      []
    )
  })

  it('carries no prompt text or tool arguments', () => {
    ledgerEventsFor('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'the secret plan' })
    const events = ledgerEventsFor('claude', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'curl -H "Authorization: Bearer abc" https://x' }
    })
    expect(JSON.stringify(events)).not.toContain('secret')
    expect(JSON.stringify(events)).not.toContain('Bearer')
  })
})

describe('Codex lifecycle → ledger events', () => {
  it('maps tool starts and the turn end', () => {
    ledgerEventsFor('codex', { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    expect(
      ledgerEventsFor('codex', {
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: { path: '/home/uma/repo/lib.py' }
      })
    ).toEqual([{ kind: 'file_write', detail: { path: '~/repo/lib.py', op: 'edit' } }])
    expect(
      ledgerEventsFor('codex', {
        hook_event_name: 'PreToolUse',
        tool_name: 'shell_command',
        tool_input: { cmd: 'pnpm test src' }
      })
    ).toEqual([{ kind: 'tool_call', detail: { tool: 'bash', target: 'pnpm' } }])
    expect(ledgerEventsFor('codex', { hook_event_name: 'Stop', model: 'gpt-5.4' })).toEqual([
      { kind: 'stop', detail: { reason: 'turn_end' } }
    ])
  })
})

describe('Gemini lifecycle → ledger events', () => {
  it('maps BeforeTool and AfterAgent', () => {
    expect(
      ledgerEventsFor('gemini', {
        hook_event_name: 'BeforeTool',
        tool_name: 'write_file',
        tool_input: { path: '/Users/maintainer/repo/index.ts', content: 'body' }
      })
    ).toEqual([{ kind: 'file_write', detail: { path: '~/repo/index.ts', op: 'create' } }])
    expect(
      ledgerEventsFor('gemini', {
        hook_event_name: 'BeforeTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'FOO=1 /usr/bin/make build' }
      })
    ).toEqual([{ kind: 'tool_call', detail: { tool: 'bash', target: 'make' } }])
    expect(ledgerEventsFor('gemini', { hook_event_name: 'AfterAgent' })).toEqual([
      { kind: 'stop', detail: { reason: 'turn_end' } }
    ])
  })
})

describe('Grok lifecycle → ledger events', () => {
  it('maps snake_case tool starts and stop', () => {
    ledgerEventsFor('grok', { hook_event_name: 'user_prompt_submit', prompt: 'go' })
    expect(
      ledgerEventsFor('grok', {
        hook_event_name: 'pre_tool_use',
        tool_name: 'search_replace',
        tool_input: { file_path: '/Users/maintainer/repo/x.go' }
      })
    ).toEqual([{ kind: 'file_write', detail: { path: '~/repo/x.go', op: 'edit' } }])
    expect(
      ledgerEventsFor('grok', {
        hook_event_name: 'pre_tool_use',
        tool_name: 'run_terminal_command',
        tool_input: { command: 'go test ./...' }
      })
    ).toEqual([{ kind: 'tool_call', detail: { tool: 'bash', target: 'go' } }])
    expect(ledgerEventsFor('grok', { hook_event_name: 'stop' })).toEqual([
      { kind: 'stop', detail: { reason: 'turn_end' } }
    ])
  })
})

describe.each(['pi', 'omp', 'prime-agent'] as const)('%s lifecycle → ledger events', (source) => {
  it('records one tool attempt and the final turn end through the real normalizer', () => {
    ledgerEventsFor(source, { hook_event_name: 'before_agent_start', prompt: 'copy the fixture' })
    const tool = { tool_name: 'bash', tool_input: { command: 'cp source.txt result.txt' } }
    const events = [
      ...ledgerEventsFor(source, { hook_event_name: 'tool_call', ...tool }),
      ...ledgerEventsFor(source, { hook_event_name: 'tool_execution_start', ...tool }),
      ...ledgerEventsFor(source, { hook_event_name: 'tool_execution_end', tool_name: 'bash' }),
      ...ledgerEventsFor(source, { hook_event_name: 'agent_end' })
    ]
    expect(events).toEqual([
      { kind: 'tool_call', detail: { tool: 'bash', target: 'cp' } },
      { kind: 'stop', detail: { reason: 'turn_end' } }
    ])
    expect(JSON.stringify(events)).not.toContain('source.txt')
    expect(isEndingHook('agent_end')).toBe(true)
    expect(isEndingHook('tool_execution_start')).toBe(false)
  })

  it('records a write attempt without publishing its content', () => {
    expect(
      ledgerEventsFor(source, {
        hook_event_name: 'tool_execution_start',
        tool_name: 'write',
        tool_input: { path: '/Users/maintainer/repo/result.txt', content: 'private file content' }
      })
    ).toEqual([{ kind: 'file_write', detail: { path: '~/repo/result.txt', op: 'create' } }])
  })
})

describe('OMP denied tools', () => {
  it('does not count proposals or approval events as extra tool attempts', () => {
    expect(
      ledgerEventsFor('omp', {
        hook_event_name: 'tool_call',
        tool_name: 'bash',
        tool_input: { command: 'cp source.txt result.txt' }
      })
    ).toEqual([])
    expect(
      ledgerEventsFor('omp', {
        hook_event_name: 'tool_execution_start',
        tool_name: 'bash',
        tool_input: { command: 'cp source.txt result.txt' }
      })
    ).toEqual([{ kind: 'tool_call', detail: { tool: 'bash', target: 'cp' } }])
    expect(
      ledgerEventsFor('omp', { hook_event_name: 'tool_approval_requested', tool_name: 'bash' })
    ).toEqual([])
    expect(
      ledgerEventsFor('omp', {
        hook_event_name: 'tool_approval_resolved',
        tool_name: 'bash',
        approved: false
      })
    ).toEqual([])
    expect(ledgerEventsFor('omp', { hook_event_name: 'agent_end' })).toEqual([
      { kind: 'stop', detail: { reason: 'turn_end' } }
    ])
  })
})

describe('mapping details', () => {
  it('reads the program name only from a shell command', () => {
    expect(shellCommandTarget('sudo env FOO=bar /opt/bin/rg pattern')).toBe('rg')
    expect(shellCommandTarget('   ')).toBe('')
    expect(shellCommandTarget(undefined)).toBe('')
  })

  it('never publishes file content or secrets carried by a write payload', () => {
    const SENTINEL = 'API_KEY=sk-live-0123456789-SENTINEL'
    const payload = JSON.stringify({
      file_path: '/Users/maintainer/My Project/src/.env',
      content: `${SENTINEL}\nOTHER=1`
    })
    for (const toolName of ['Write', 'Edit', 'str_replace_editor', 'write_file']) {
      const events = mapHookToLedgerEvents(
        { hookEventName: 'PreToolUse', toolName, toolInput: payload },
        { publishPath }
      )
      expect(events).toEqual([
        { kind: 'file_write', detail: { path: '~/My Project/src/.env', op: expect.any(String) } }
      ])
      expect(JSON.stringify(events)).not.toContain('SENTINEL')
      expect(JSON.stringify(events)).not.toContain('sk-live')
    }
    // A payload with no path key, or object-like content in place of a path, yields no path.
    for (const toolInput of [
      JSON.stringify({ content: SENTINEL }),
      JSON.stringify({ old_string: 'a', new_string: SENTINEL }),
      `"content": "${SENTINEL}"`,
      `[${SENTINEL}]`,
      `line one\n${SENTINEL}`,
      '{"file_path": "/x", "content": "unterminated'
    ]) {
      const events = mapHookToLedgerEvents(
        { hookEventName: 'PreToolUse', toolName: 'Write', toolInput },
        { publishPath }
      )
      expect(events).toEqual([{ kind: 'tool_call', detail: { tool: 'Write' } }])
      expect(JSON.stringify(events)).not.toContain('SENTINEL')
    }
  })

  it('keeps genuine spaced paths from a path key or a plain string, stripped of the username', () => {
    expect(
      mapHookToLedgerEvents(
        {
          hookEventName: 'PreToolUse',
          toolName: 'Write',
          toolInput: JSON.stringify({ file_path: 'My Project/src/a.ts', content: 'API_KEY=x' })
        },
        { publishPath }
      )
    ).toEqual([{ kind: 'file_write', detail: { path: 'My Project/src/a.ts', op: 'create' } }])
    expect(
      mapHookToLedgerEvents(
        {
          hookEventName: 'PreToolUse',
          toolName: 'Edit',
          toolInput: '/Users/maintainer/Library/Application Support/Orca/notes.md'
        },
        { publishPath }
      )
    ).toEqual([
      {
        kind: 'file_write',
        detail: { path: '~/Library/Application Support/Orca/notes.md', op: 'edit' }
      }
    ])
  })

  it('reads the write target from known path keys only, and from a string only when not object-like', () => {
    expect(writeTargetPath(JSON.stringify({ path: 'src/a.ts', content: 'x' }))).toBe('src/a.ts')
    expect(writeTargetPath(JSON.stringify({ notebook_path: 'nb.ipynb' }))).toBe('nb.ipynb')
    expect(writeTargetPath(JSON.stringify({ TargetFile: 'C:\\repo\\a.ts' }))).toBe('C:\\repo\\a.ts')
    expect(writeTargetPath(JSON.stringify({ file_path: 'has space/a.ts' }))).toBe('has space/a.ts')
    expect(writeTargetPath(JSON.stringify({ file_path: 'two\nlines' }))).toBeNull()
    expect(writeTargetPath(JSON.stringify({ file_path: `/${'a'.repeat(1100)}` }))).toBeNull()
    expect(writeTargetPath(JSON.stringify({ file_path: 42, content: 'x' }))).toBeNull()
    expect(writeTargetPath(JSON.stringify({ old_string: 'a', new_string: 'b' }))).toBeNull()
    expect(writeTargetPath('/Users/maintainer/repo/a.ts')).toBe('/Users/maintainer/repo/a.ts')
    expect(writeTargetPath('Sal Docs/notes.md')).toBe('Sal Docs/notes.md')
    expect(writeTargetPath('{not json')).toBeNull()
    expect(writeTargetPath('[]')).toBeNull()
    expect(writeTargetPath('"file_path": "/x"')).toBeNull()
    expect(writeTargetPath('')).toBeNull()
    expect(writeTargetPath(undefined)).toBeNull()
  })

  it('never publishes a shell command line, its arguments or an inline secret', () => {
    const SENTINEL = 'sk-live-0123456789-SENTINEL'
    for (const command of [
      `curl -H "Authorization: Bearer ${SENTINEL}" https://api.example.test`,
      `AWS_SECRET_ACCESS_KEY=${SENTINEL} aws s3 ls`,
      `echo ${SENTINEL} | pbcopy`
    ]) {
      const events = mapHookToLedgerEvents(
        { hookEventName: 'PreToolUse', toolName: 'Bash', toolInput: command },
        { publishPath }
      )
      expect(events).toHaveLength(1)
      const detail = events[0]?.detail as { tool: string; target?: string }
      expect(detail.tool).toBe('bash')
      expect(['curl', 'aws', 'echo']).toContain(detail.target ?? '')
      expect(JSON.stringify(events)).not.toContain('SENTINEL')
    }
    // Shell syntax in the program position is not a label; the target is omitted.
    expect(shellCommandTarget(`$(cat ${SENTINEL}) run`)).toBe('')
    expect(shellCommandTarget(`"${SENTINEL}"`)).toBe('')
    expect(shellCommandTarget(`{ ${SENTINEL}; }`)).toBe('')
    expect(shellCommandTarget(`${'x'.repeat(65)} arg`)).toBe('')
    expect(
      mapHookToLedgerEvents(
        { hookEventName: 'PreToolUse', toolName: 'Bash', toolInput: `"${SENTINEL}" arg` },
        { publishPath }
      )
    ).toEqual([{ kind: 'tool_call', detail: { tool: 'bash' } }])
  })

  it('names unknown tools without arguments', () => {
    expect(
      mapHookToLedgerEvents(
        { hookEventName: 'PreToolUse', toolName: 'WebFetch', toolInput: 'https://example.test' },
        { publishPath }
      )
    ).toEqual([{ kind: 'tool_call', detail: { tool: 'WebFetch' } }])
  })

  it('maps session_end to an exit stop and ignores unrelated hooks', () => {
    expect(mapHookToLedgerEvents({ hookEventName: 'SessionEnd' }, { publishPath })).toEqual([
      { kind: 'stop', detail: { reason: 'exit' } }
    ])
    expect(mapHookToLedgerEvents({ hookEventName: 'Notification' }, { publishPath })).toEqual([])
    expect(mapHookToLedgerEvents({ hookEventName: 'SessionStart' }, { publishPath })).toEqual([])
  })

  it('names the teardown reasons of the contract; a lost remote pane is closed, never exited', () => {
    expect(stopReasonForTeardown('pty-exit')).toBe('exit')
    expect(stopReasonForTeardown('tab-close')).toBe('close')
    expect(stopReasonForTeardown('remote-lost')).toBe('close')
    expect(stopReasonForTeardown('quit')).toBe('quit')
  })
})
