import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeEnvPatch } from './environment'

export type ClaudeRuntimePaths = {
  configDir: string
  credentialsPath: string
  configPath: string
  envPatch: ClaudeEnvPatch
}

export class ClaudeRuntimePathResolver {
  getRuntimePaths(
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
  ): ClaudeRuntimePaths {
    const inheritedConfigDir = env.CLAUDE_CONFIG_DIR?.trim() || null
    const configDir = inheritedConfigDir || join(home, '.claude')
    mkdirSync(configDir, { recursive: true })

    return {
      configDir,
      credentialsPath: join(configDir, '.credentials.json'),
      configPath: this.resolveConfigPath(configDir, inheritedConfigDir, home),
      envPatch: inheritedConfigDir ? { CLAUDE_CONFIG_DIR: configDir } : {}
    }
  }

  private resolveConfigPath(
    configDir: string,
    inheritedConfigDir: string | null,
    home: string
  ): string {
    const colocatedConfigPath = join(configDir, '.claude.json')
    if (inheritedConfigDir || existsSync(colocatedConfigPath)) {
      return colocatedConfigPath
    }
    return join(home, '.claude.json')
  }
}
