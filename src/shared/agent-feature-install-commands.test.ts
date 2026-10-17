import { describe, expect, it } from 'vitest'
import {
  buildAgentFeatureSkillInstallArgs,
  buildAgentFeatureSkillInstallCommand,
  ORCA_CLI_SKILL_INSTALL_COMMAND,
  buildAgentFeatureSkillUpdateArgs,
  buildAgentFeatureSkillUpdateCommand,
  COMPUTER_USE_SKILL_UPDATE_COMMAND,
  EPHEMERAL_VMS_SKILL_UPDATE_COMMAND,
  LINEAR_TICKETS_SKILL_UPDATE_COMMAND,
  ORCA_LINEAR_SKILL_UPDATE_COMMAND,
  ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND,
  ORCA_CLI_SKILL_UPDATE_COMMAND,
  ORCHESTRATION_SKILL_UPDATE_COMMAND
} from './agent-feature-install-commands'

describe('agent feature skill commands', () => {
  it('refreshes a bundled skill without relying on registry tracking', () => {
    expect(
      buildAgentFeatureSkillUpdateArgs('omni-cli', {
        yes: true,
        agents: ['codex']
      })
    ).toEqual(
      buildAgentFeatureSkillInstallArgs(['omni-cli'], {
        yes: true,
        agents: ['codex']
      })
    )
    expect(() => buildAgentFeatureSkillUpdateArgs('omni-cli', { yes: true })).toThrow(
      'An install target is required when skipping prompts.'
    )
  })

  it('builds a global install command by default', () => {
    expect(buildAgentFeatureSkillInstallCommand(['omni-cli'])).toBe(
      'npx skills add /Applications/OmniConsole.app/Contents/Resources/skill-sources --skill omni-cli --global'
    )
  })

  it('drops --global when installing locally', () => {
    expect(buildAgentFeatureSkillInstallCommand(['omni-cli'], { global: false })).toBe(
      'npx skills add /Applications/OmniConsole.app/Contents/Resources/skill-sources --skill omni-cli'
    )
  })

  it('repeats --skill per name for multi-skill installs', () => {
    expect(buildAgentFeatureSkillInstallCommand(['omni-cli', 'orchestration'])).toBe(
      'npx skills add /Applications/OmniConsole.app/Contents/Resources/skill-sources --skill omni-cli --skill orchestration --global'
    )
    expect(buildAgentFeatureSkillInstallArgs(['omni-cli', 'orchestration'])).toEqual([
      'skills',
      'add',
      '/Applications/OmniConsole.app/Contents/Resources/skill-sources',
      '--skill',
      'omni-cli',
      '--skill',
      'orchestration',
      '--global'
    ])
  })

  it('keeps the copyable Settings commands interactive by default', () => {
    // Why: -y skips the agent picker. A human pasting from Settings should still
    // get it; only an unattended spawn opts in.
    expect(buildAgentFeatureSkillInstallCommand(['omni-cli'])).not.toContain('-y')
    expect(buildAgentFeatureSkillUpdateCommand('omni-cli')).not.toContain('-y')
    expect(ORCA_CLI_SKILL_INSTALL_COMMAND).not.toContain('-y')
    expect(ORCA_CLI_SKILL_UPDATE_COMMAND).not.toContain('-y')
  })

  it('refuses to skip prompts without an install target', () => {
    // Why: -y with no --agent is the one combination that makes `skills add`
    // install into every agent it knows (~75). No caller may express it.
    expect(() => buildAgentFeatureSkillInstallCommand(['omni-cli'], { yes: true })).toThrow(
      'An install target is required when skipping prompts.'
    )
  })

  it('refuses a target the skills CLI would drop', () => {
    // Why: defence in depth behind the CLI's own check — the skills CLI silently
    // drops a `-`-leading --agent value, which empties its target list and
    // installs into every agent it knows.
    expect(() =>
      buildAgentFeatureSkillInstallCommand(['omni-cli'], {
        yes: true,
        agents: ['-y']
      })
    ).toThrow('"-y" is not a usable install target.')
    expect(() =>
      buildAgentFeatureSkillInstallArgs(['omni-cli'], {
        yes: true,
        agents: ['universal', 'a b']
      })
    ).toThrow('"a b" is not a usable install target.')
  })

  it('appends -y and the targets for an unattended run', () => {
    expect(
      buildAgentFeatureSkillInstallCommand(['omni-cli'], {
        yes: true,
        agents: ['universal']
      })
    ).toBe(
      'npx skills add /Applications/OmniConsole.app/Contents/Resources/skill-sources --skill omni-cli --global --agent universal -y'
    )
    expect(
      buildAgentFeatureSkillUpdateCommand(['omni-cli'], {
        global: false,
        yes: true,
        agents: ['universal']
      })
    ).toBe(
      'npx skills add /Applications/OmniConsole.app/Contents/Resources/skill-sources --skill omni-cli --agent universal -y'
    )
    expect(
      buildAgentFeatureSkillInstallArgs(['omni-cli'], {
        yes: true,
        agents: ['universal']
      }).at(-1)
    ).toBe('-y')
    expect(
      buildAgentFeatureSkillUpdateArgs(['omni-cli'], {
        yes: true,
        agents: ['universal']
      }).at(-1)
    ).toBe('-y')
  })

  it('builds single-skill update commands', () => {
    expect(buildAgentFeatureSkillUpdateCommand('orchestration')).toBe(
      'npx skills add /Applications/OmniConsole.app/Contents/Resources/skill-sources --skill orchestration --global'
    )
  })

  it('trims and rejects blank update skill names', () => {
    expect(buildAgentFeatureSkillUpdateCommand('  omni-cli  ')).toBe(
      'npx skills add /Applications/OmniConsole.app/Contents/Resources/skill-sources --skill omni-cli --global'
    )
    expect(() => buildAgentFeatureSkillUpdateCommand('   ')).toThrow('A skill name is required.')
  })

  it('builds multi-skill update commands and selects project scope for --local', () => {
    expect(buildAgentFeatureSkillUpdateCommand(['omni-cli', 'orchestration'])).toBe(
      'npx skills add /Applications/OmniConsole.app/Contents/Resources/skill-sources --skill omni-cli --skill orchestration --global'
    )
    expect(buildAgentFeatureSkillUpdateCommand(['omni-cli'], { global: false })).toBe(
      'npx skills add /Applications/OmniConsole.app/Contents/Resources/skill-sources --skill omni-cli'
    )
    expect(buildAgentFeatureSkillUpdateArgs(['omni-cli'], { global: false })).toEqual([
      'skills',
      'add',
      '/Applications/OmniConsole.app/Contents/Resources/skill-sources',
      '--skill',
      'omni-cli'
    ])
    expect(() => buildAgentFeatureSkillUpdateCommand([])).toThrow('A skill name is required.')
  })

  it('exports single-skill update constants without changing install bundles', () => {
    expect(ORCA_CLI_SKILL_UPDATE_COMMAND).toBe(
      'npx skills add /Applications/OmniConsole.app/Contents/Resources/skill-sources --skill omni-cli --global'
    )
    expect(COMPUTER_USE_SKILL_UPDATE_COMMAND).toBe(
      'npx skills add /Applications/OmniConsole.app/Contents/Resources/skill-sources --skill computer-use --global'
    )
    expect(ORCHESTRATION_SKILL_UPDATE_COMMAND).toBe(
      'npx skills add /Applications/OmniConsole.app/Contents/Resources/skill-sources --skill orchestration --global'
    )
    expect(EPHEMERAL_VMS_SKILL_UPDATE_COMMAND).toBe(
      'npx skills add /Applications/OmniConsole.app/Contents/Resources/skill-sources --skill omni-per-workspace-env --global'
    )
    expect(ORCA_LINEAR_SKILL_UPDATE_COMMAND).toBe(
      'npx skills add /Applications/OmniConsole.app/Contents/Resources/skill-sources --skill omni-linear --global'
    )
    expect(LINEAR_TICKETS_SKILL_UPDATE_COMMAND).toBe(
      'npx skills add /Applications/OmniConsole.app/Contents/Resources/skill-sources --skill linear-tickets --global'
    )
    expect(ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND).toBe(
      buildAgentFeatureSkillInstallCommand(['omni-cli', 'orchestration'])
    )
  })
})
