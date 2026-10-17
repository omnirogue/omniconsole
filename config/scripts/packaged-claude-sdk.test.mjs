import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createPackagedRuntimeNodeModuleResources } = require('../packaged-runtime-node-modules.cjs')

it.each(['darwin', 'linux', 'win32'])(
  'loads the deferred Claude SDK from isolated %s packaged resources',
  (platform) => {
    const resources = createPackagedRuntimeNodeModuleResources(platform)
    const sdk = resources.find(
      (entry) => entry.to === join('node_modules', '@anthropic-ai', 'claude-agent-sdk')
    )
    expect(sdk).toBeDefined()
    const packagedResources = mkdtempSync(join(tmpdir(), 'omni-claude-packaged-runtime-'))
    try {
      mkdirSync(join(packagedResources, 'node_modules', '@anthropic-ai'), { recursive: true })
      cpSync(sdk.from, join(packagedResources, sdk.to), { recursive: true })
      const result = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'const sdk = await import("@anthropic-ai/claude-agent-sdk"); console.log(typeof sdk.query)'
        ],
        { cwd: packagedResources, encoding: 'utf8', timeout: 15_000 }
      )
      expect(result.trim()).toBe('function')
    } finally {
      rmSync(packagedResources, { recursive: true, force: true })
    }
  }
)
