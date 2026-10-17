import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const { FileMatcher } = require('app-builder-lib/out/fileMatcher')

describe('dispatch router packaging', () => {
  it('ships the existing Python router as real resources outside app.asar', () => {
    for (const platform of ['mac', 'linux', 'win']) {
      expect(electronBuilderConfig[platform].extraResources).toContainEqual({
        from: 'resources/dispatch-router',
        to: 'dispatch-router'
      })
    }
    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    matcher.prependPattern('**/*')
    expect(
      matcher.createFilter()(join('/app', 'resources/dispatch-router/omni_route.py'), {
        isDirectory: () => false
      })
    ).toBe(false)
  })
})
