import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  forgetTeamConnectorChoice,
  updateTeamConnectorConfig
} from '../mcp/connector-config-preservation'

export type TeamConfigTarget = {
  file: string
  provider: 'claude' | 'codex' | 'gemini' | 'grok'
  home?: string
}

/** Remember destinations before writing so removed accounts and new launch homes can be cleaned. */
export class TeamConfigTargets {
  constructor(private readonly file: string) {}
  private read(): TeamConfigTarget[] {
    if (!existsSync(this.file)) {
      return []
    }
    const targets: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
    if (
      !Array.isArray(targets) ||
      targets.some(
        (target) =>
          !target ||
          typeof target.file !== 'string' ||
          !['claude', 'codex', 'gemini', 'grok'].includes(target.provider) ||
          (target.home !== undefined && typeof target.home !== 'string')
      )
    ) {
      throw new Error('OmniSI configuration destinations could not be read.')
    }
    return targets
  }
  remember(target: TeamConfigTarget): void {
    const targets = this.read()
    if (
      targets.some((existing) => existing.file === target.file && existing.home === target.home)
    ) {
      return
    }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    writeFileAtomically(this.file, JSON.stringify([...targets, target]), { mode: 0o600 })
  }
  clear(): void {
    for (const target of this.read()) {
      updateTeamConnectorConfig(target.file, target.provider, null)
      if (target.home) {
        forgetTeamConnectorChoice(target.home)
      }
    }
    if (existsSync(this.file)) {
      unlinkSync(this.file)
    }
  }
}
