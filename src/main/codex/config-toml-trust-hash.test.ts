import { describe, expect, it } from 'vitest'
import { computeTrustedHash, type CodexTrustEntry } from './config-toml-trust'
import { createCodexHookTrustEntry } from './codex-hook-identity'

// Why: captured from a real Codex 0.129 `/hooks` approval; fails loudly if Codex's serialization drifts.
const REAL_APPROVED_COMMAND = '/bin/sh "/tmp/omni-case-b-mCmCe6/agent-hooks/codex-hook.sh"'
const REAL_APPROVED_HASH = 'sha256:ba28939fb01af00723a7e3819e01f7947d1215803f464b423cbaff9fb9caca0a'

describe('computeTrustedHash', () => {
  it('reproduces the hash that Codex /hooks wrote for a real approval', () => {
    expect(
      computeTrustedHash({
        sourcePath: '/Users/thebr/.codex/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: REAL_APPROVED_COMMAND
      })
    ).toBe(REAL_APPROVED_HASH)
  })

  it('reproduces the hash Codex wrote for a real SessionEnd hook with an empty matcher', () => {
    // Why: captured from Codex 0.160 trust in ~/.codex/config.toml (17 Oct 2026); session_end hashes its matcher.
    expect(
      computeTrustedHash({
        sourcePath: '/Users/maintainer/.codex/hooks.json',
        eventLabel: 'session_end',
        groupIndex: 0,
        handlerIndex: 0,
        command:
          '/usr/bin/python3 /Users/maintainer/Work/Ops/bin/omni-session-context hook --provider codex --event SessionEnd',
        timeoutSec: 3,
        matcher: ''
      })
    ).toBe('sha256:95a6c8697871d9274514b2054f3fe466166e0d9ecef752f951288bcb8fd48e25')
  })

  it('gives a SessionEnd hook a trust entry so mirrored SessionEnd hooks keep their trust', () => {
    const entry = createCodexHookTrustEntry(
      '/x/hooks.json',
      'SessionEnd',
      1,
      0,
      { hooks: [] },
      { type: 'command', command: 'python3 /x/question-mirror.py --provider codex', timeout: 5 }
    )
    expect(entry).toMatchObject({
      eventLabel: 'session_end',
      groupIndex: 1,
      handlerIndex: 0,
      timeoutSec: 5
    })
  })

  it('produces a different hash when the command changes', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'bar'
    })
    expect(a).not.toBe(b)
  })

  it('produces a different hash when the event label changes', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'post_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    expect(a).not.toBe(b)
  })

  it('ignores groupIndex/handlerIndex (those are part of the key, not the hash)', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 99,
      handlerIndex: 99,
      command: 'foo'
    })
    expect(a).toBe(b)
  })

  it('hashes a missing matcher the same as no matcher field', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      matcher: undefined
    })
    expect(a).toBe(b)
  })

  it('produces a different hash when matcher is set', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      matcher: 'foo'
    })
    expect(a).not.toBe(b)
  })

  it('drops the matcher on user_prompt_submit/stop like matcher_pattern_for_event', () => {
    // Why: Codex hashes these two events WITHOUT the matcher, so `"matcher": ""` must hash like no matcher.
    for (const eventLabel of ['user_prompt_submit', 'stop'] as const) {
      const base: CodexTrustEntry = {
        sourcePath: '/x/hooks.json',
        eventLabel,
        groupIndex: 0,
        handlerIndex: 0,
        command: 'foo'
      }
      const bare = computeTrustedHash(base)
      expect(computeTrustedHash({ ...base, matcher: '' })).toBe(bare)
      expect(computeTrustedHash({ ...base, matcher: 'anything' })).toBe(bare)
    }
  })

  it('pins the matcher-omitted hash for a Stop entry that carries an empty matcher', () => {
    // Why: regression pin (real Codex 0.140 config) — Stop uses the matcher-omitted hash even with `"matcher": ""`.
    expect(
      computeTrustedHash({
        sourcePath: '/home/user/.codex/hooks.json',
        eventLabel: 'stop',
        groupIndex: 0,
        handlerIndex: 0,
        command: '/home/user/.tma1/hooks/agent-hook.sh',
        matcher: ''
      })
    ).toBe('sha256:f8b48c31eabfba63f117b8570b839a5f6efc1d67867512d661775b5312df946f')
  })

  it('produces a different hash when statusMessage is set', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      statusMessage: 'msg'
    })
    expect(a).not.toBe(b)
  })

  it('produces a different hash when async flips from default false to true', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      async: false
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      async: true
    })
    expect(a).not.toBe(b)
  })

  it('clamps timeoutSec=0 to 1 (which differs from the unset default of 600)', () => {
    const zero = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      timeoutSec: 0
    })
    const one = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      timeoutSec: 1
    })
    const unset = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    expect(zero).toBe(one)
    expect(zero).not.toBe(unset)
  })
})
