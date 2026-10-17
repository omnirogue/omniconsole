import { describe, expect, it } from 'vitest'
import { literalPromptCommand } from './session-prompt-command'
import { readStructuredSessionPrompt } from './session-prompt-structured'
import { parseSessionPromptScreen } from './session-prompt-screen'
import { selectSessionAnswer } from './session-manage-answer'
import type { AgentJournalApprovalItem } from '../../shared/agent-session-journal-types'

function approval(detail: string, extra: Partial<AgentJournalApprovalItem> = {}) {
  return readStructuredSessionPrompt('chat', {
    fence: 1,
    items: [
      {
        itemId: 'approval',
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: {
          kind: 'approval',
          title: 'Allow Bash?',
          detail,
          options: [
            { id: 'allow', label: 'Allow' },
            { id: 'deny', label: 'Deny' }
          ],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          },
          ...extra
        }
      }
    ]
  })!
}

describe('executable permission evidence', () => {
  it.each([
    'git\tpush origin main',
    'git --no-pager clean -fd',
    'git -c alias.st=clean st',
    `git -c 'alias.a=pu""sh' a origin feature`,
    `git -c 'alias.a=re""set --hard' a`,
    `git -c 'alias.a=re""flog expire --expire=now' a`,
    `git -c 'alias.a=st""ash clear' a`,
    `git -c alias.a=b -c 'alias.b=pu""sh' a origin feature`,
    "git -c alias.st='clean -fd' st",
    'git -calias.st=clean st',
    'git -c alias.first=second -c alias.second=clean first',
    'git --config-env=alias.st=COMMAND st',
    'git --config-env alias.st=COMMAND st',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.a GIT_CONFIG_VALUE_0=clean git a -fd',
    'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.a GIT_CONFIG_VALUE_0=clean git a -fd',
    `GIT_CONFIG_PARAMETERS="'alias.a=clean'" git a -fd`,
    'FOO=1 git --no-pager clean -fd',
    'env FOO=1 git -C src clean -fd',
    'command git --no-pager clean -fd',
    'sudo -u root git -C src clean -fd',
    'env FOO=1 curl -X DELETE https://example.test/item',
    'timeout 5 curl -XDELETE https://example.test/item',
    'git -C src clean -fd',
    'git -c core.quotePath=false clean -fd',
    'git --work-tree=src --no-pager clean -fd',
    '/usr/bin/git -Csrc clean -fd',
    'curl -X DELETE https://example.test/item',
    'curl --request=DELETE https://example.test/item',
    'curl -sSXDELETE https://example.test/item',
    'curl -sSX DELETE https://example.test/item',
    'git --exec-path=/tools clean -fd',
    'git --exec-path=/tools -c alias.st=clean st -fd',
    'git -c alias.st=clean --exec-path=/tools st -fd',
    "g''it p''ush origin main",
    'g\\it pu"sh" origin main',
    "r''m file",
    'g\\\nit p\\\nush origin main'
  ])('classifies decoded and literal shell words for %s', (command) => {
    const prompt = approval(JSON.stringify({ command }))
    expect(prompt.readable).toBe(true)
    expect(prompt.commandText).toContain(command)
    expect(() => selectSessionAnswer(prompt, { kind: 'allow' }, { kind: 'cli' })).toThrow(
      'hard stop'
    )
    expect(selectSessionAnswer(prompt, { kind: 'deny' }, { kind: 'cli' }).value).toBe('deny')
    const screen = `Bash command\n  ${command}\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel`
    const parsed = parseSessionPromptScreen('claude', screen)!
    expect(() =>
      selectSessionAnswer(
        { ...parsed, delivery: { kind: 'pty', handle: 'term', ptyId: 'pty', screen } },
        { kind: 'allow' },
        { kind: 'cli' }
      )
    ).toThrow('hard stop')
  })

  it.each(['git status', 'g\'\'it st"at"us', 'git\tstatus', 'g\\it status'])(
    'allows complete literal inspection %s',
    (command) => {
      expect(literalPromptCommand(command)).toBe('git status')
      expect(
        selectSessionAnswer(
          approval(JSON.stringify({ command })),
          { kind: 'allow' },
          { kind: 'cli' }
        ).value
      ).toBe('allow')
    }
  )

  it.each([
    '$CMD status',
    'g$(printf it) push',
    'git status; deploy',
    'git status > file',
    "bash -c 'g\\it push'",
    'g*it push',
    "git 'status",
    "git 'sta\\\ntus'",
    'python -c "pass"'
  ])('refuses uncertain shell execution but still denies %s', (command) => {
    const prompt = approval(JSON.stringify({ command }))
    expect(prompt.readable).toBe(false)
    expect(() => selectSessionAnswer(prompt, { kind: 'allow' }, { kind: 'cli' })).toThrow(
      'cannot be read completely'
    )
    expect(selectSessionAnswer(prompt, { kind: 'deny' }, { kind: 'cli' }).value).toBe('deny')
  })

  it.each([
    '{"description":"inspect"}',
    '{"command":["git","status"]}',
    '{"command":"pwd"',
    '"pwd"'
  ])('requires a complete supported tool input: %s', (detail) => {
    expect(approval(detail).readable).toBe(false)
  })

  it('never treats a Codex explanation as executable evidence, and hashes its separate command', () => {
    const missing = approval('Inspect the repo', { title: 'Run a command?' })
    expect(missing.readable).toBe(false)
    const safe = approval('Inspect the repo', { title: 'Run a command?', command: 'git status' })
    expect(selectSessionAnswer(safe, { kind: 'allow' }, { kind: 'cli' }).value).toBe('allow')
    const push = approval('Inspect the repo', {
      title: 'Run a command?',
      command: 'git\tpush origin main'
    })
    expect(push.ask.fingerprint).not.toBe(safe.ask.fingerprint)
    expect(() => selectSessionAnswer(push, { kind: 'allow' }, { kind: 'cli' })).toThrow('hard stop')
  })
})

it.each([
  'git -C clean status',
  'env FOO=1 git -C clean status',
  'command git -C src commit -m update',
  'git -c alias.clean=status status',
  'git -c alias.st=status st',
  'git -c alias.st=clean -c alias.st=status st',
  'git --no-pager status',
  'git -C src commit -m update',
  'touch local-file',
  'curl -X GET https://example.test/item'
])('keeps ordinary literal work available: %s', (command) => {
  expect(
    selectSessionAnswer(approval(JSON.stringify({ command })), { kind: 'allow' }, { kind: 'cli' })
      .value
  ).toBe('allow')
})
