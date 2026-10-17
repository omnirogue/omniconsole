import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { loadConfigFromFile } from 'electron-vite'
import { afterEach, describe, expect, it, vi } from 'vitest'

const temporaryRoots = []
const sentinelName = 'electron.vite.config.keep.mjs'
const sentinelContents = '// Another loader owns this file.\n'

function createConfigFiles(sources) {
  const root = mkdtempSync(join(tmpdir(), 'electron-vite-config-concurrency-'))
  temporaryRoots.push(root)
  writeFileSync(join(root, sentinelName), sentinelContents)
  const files = sources.map((source, index) => {
    const file = join(root, `target-${index}.config.mjs`)
    writeFileSync(file, source)
    return file
  })
  return { root, files }
}

function loadConfig(file, root) {
  return loadConfigFromFile({ command: 'build', mode: 'production' }, file, root, 'silent', true)
}

function expectTemporaryFilesRemoved(root, files) {
  expect(readdirSync(root).sort()).toEqual(
    [...files.map((file) => basename(file)), sentinelName].sort()
  )
  expect(readFileSync(join(root, sentinelName), 'utf8')).toBe(sentinelContents)
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('electron-vite config concurrency', () => {
  it('loads distinct target configs in one root at the same timestamp', async () => {
    const targets = ['main', 'preload', 'renderer']
    const expectedConfigs = targets.map((target) => ({
      [target]: { define: { __CONFIG_TARGET__: JSON.stringify(target) } }
    }))
    const { root, files } = createConfigFiles(
      expectedConfigs.map((config) => `export default ${JSON.stringify(config)}\n`)
    )

    // A shared timestamp must not alias native ESM imports, regardless of bundling order.
    vi.spyOn(Date, 'now').mockReturnValue(1_789_956_862_931)
    const results = await Promise.allSettled(files.map((file) => loadConfig(file, root)))

    expect(results.map((result) => result.status)).toEqual(targets.map(() => 'fulfilled'))
    expect(results.map((result) => result.value.config)).toEqual(expectedConfigs)
    expectTemporaryFilesRemoved(root, files)
  })

  it('isolates an import failure and cleans up only loader-owned temporary files', async () => {
    const failureMessage = 'intentional config import failure'
    const healthyConfig = { main: { define: { __CONFIG_TARGET__: JSON.stringify('healthy') } } }
    const { root, files } = createConfigFiles([
      `throw new Error(${JSON.stringify(failureMessage)})\nexport default { main: {} }\n`,
      `export default ${JSON.stringify(healthyConfig)}\n`
    ])

    vi.spyOn(Date, 'now').mockReturnValue(1_789_956_862_931)
    const results = await Promise.allSettled(files.map((file) => loadConfig(file, root)))

    expect(results[0]).toMatchObject({
      status: 'rejected',
      reason: { message: failureMessage }
    })
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: { config: healthyConfig } })
    expectTemporaryFilesRemoved(root, files)
  })
})
