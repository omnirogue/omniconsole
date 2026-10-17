import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createPackagedRuntimeNodeModuleResources } = require('../packaged-runtime-node-modules.cjs')

it.each(['darwin', 'linux', 'win32'])(
  'loads the MCP TOML parser from isolated %s runtime resources',
  (platform) => {
    const resources = createPackagedRuntimeNodeModuleResources(platform)
    const parser = resources.find((entry) => entry.to === join('node_modules', 'smol-toml'))
    expect(parser).toBeDefined()
    const packagedResources = mkdtempSync(join(tmpdir(), 'omni-mcp-packaged-runtime-'))
    try {
      mkdirSync(join(packagedResources, 'node_modules'), { recursive: true })
      cpSync(parser.from, join(packagedResources, parser.to), { recursive: true })
      // Why: resolve from the packaged resources, outside the checkout's node_modules.
      const packagedRequire = createRequire(join(packagedResources, 'out', 'cli', 'index.js'))
      expect(packagedRequire.resolve('smol-toml')).toContain(join(packagedResources, parser.to))
      expect(
        packagedRequire('smol-toml').parse('[mcp_servers."omni-console"]\nenabled = false')
      ).toEqual({ mcp_servers: { 'omni-console': { enabled: false } } })
    } finally {
      rmSync(packagedResources, { recursive: true, force: true })
    }
  }
)
