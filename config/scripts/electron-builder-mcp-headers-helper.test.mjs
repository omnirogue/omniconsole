import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const { FileMatcher } = require('app-builder-lib/out/fileMatcher')

// Why: Claude Code runs this helper by absolute path as the omni-console MCP headersHelper
// (src/main/mcp/omni-console-mcp-headers-helper.ts); it must be a real Resources/mcp file on
// the Unix platforms, never only inside app.asar, and Windows keeps the `headers` shape.
describe('omni-console MCP headers helper packaging', () => {
  const helper = { from: 'resources/mcp', to: 'mcp' }

  it('ships the helper through extraResources on macOS and Linux only', () => {
    expect(electronBuilderConfig.mac.extraResources).toContainEqual(helper)
    expect(electronBuilderConfig.linux.extraResources).toContainEqual(helper)
    expect(electronBuilderConfig.win.extraResources).not.toContainEqual(helper)
  })

  it('keeps the helper source out of app.asar', () => {
    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    expect(
      isPacked(join('/app', 'resources/mcp/omni-console-mcp-headers.sh'), {
        isDirectory: () => false
      })
    ).toBe(false)
  })
})
