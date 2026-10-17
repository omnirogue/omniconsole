import { describe, expect, it } from 'vitest'
import { conversationLauncherArgs } from './launch-agent-in-new-tab-defaults'
import { tokenizeStartupCommand } from '../../../shared/tui-agent-startup-shell'

describe('launcher argument defaults', () => {
  it.each(['posix', 'powershell', 'cmd'] as const)(
    'removes Claude model/effort but keeps other flags on %s',
    (shell) => {
      const args = conversationLauncherArgs(
        'claude',
        '--dangerously-skip-permissions --model sonnet --effort high',
        shell
      )
      expect(tokenizeStartupCommand(args!, shell)).toMatchObject({
        ok: true,
        tokens: ['--dangerously-skip-permissions']
      })
    }
  )
  it('removes Codex reasoning selection without dropping unrelated config', () => {
    const args = conversationLauncherArgs(
      'codex',
      '-m old -c model_reasoning_effort=high -c approval_policy=never',
      'posix'
    )
    expect(tokenizeStartupCommand(args!, 'posix')).toMatchObject({
      ok: true,
      tokens: ['-c', 'approval_policy=never']
    })
  })
  it('leaves malformed arguments for the startup validator to reject', () => {
    expect(conversationLauncherArgs('claude', '--model "', 'posix')).toBe('--model "')
  })
})

it.each(['posix', 'powershell', 'cmd'] as const)(
  'removes Gemini model overrides while preserving permissions on %s',
  (shell) => {
    const args = conversationLauncherArgs('gemini', '-y -m old --model=older', shell)
    expect(tokenizeStartupCommand(args!, shell)).toMatchObject({ ok: true, tokens: ['-y'] })
  }
)
