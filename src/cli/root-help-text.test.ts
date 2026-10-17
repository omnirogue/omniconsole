import { describe, expect, it } from 'vitest'
import { formatCommandHelp } from './help'
import { ROOT_HELP_TEXT_SECONDARY } from './root-help-text-secondary'
import { COMMAND_SPECS } from './specs/index'

const AGENT_VIA_COMMAND_FLAG = /--command ["'](?:codex|claude)\b/u

function commandHelp(path: string): string {
  const spec = COMMAND_SPECS.find((entry) => entry.path.join(' ') === path)
  if (!spec) {
    throw new Error(`Missing command spec: ${path}`)
  }
  return formatCommandHelp(spec)
}

// Why: `omni --help` and the create help are what an agent without the skill guides reads; an
// agent started with `terminal create --command codex` skips the verified-account launcher.
describe('fresh agent launch help', () => {
  it('root help starts a fresh Claude or Codex with session launch', () => {
    expect(ROOT_HELP_TEXT_SECONDARY).toContain(
      'omni session launch --provider codex --prompt-file <brief.md> --json'
    )
    expect(ROOT_HELP_TEXT_SECONDARY).toContain('Supervised workers use orchestration worker-start.')
    expect(ROOT_HELP_TEXT_SECONDARY).not.toMatch(AGENT_VIA_COMMAND_FLAG)
  })

  it('terminal and worktree create help never start an agent with --command', () => {
    for (const path of ['terminal create', 'worktree create']) {
      const help = commandHelp(path)

      expect(help).toContain('omni session launch')
      expect(help).not.toMatch(AGENT_VIA_COMMAND_FLAG)
    }
  })
})
