import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createMacBuildCompatibility } = require('./mac-build-compatibility.cjs')

describe('mac build compatibility metadata', () => {
  it('binds version, commit, and architecture into the packaged contract', () => {
    expect(
      createMacBuildCompatibility({
        version: '1.2.3-local.1',
        commit: 'abc123',
        architecture: 'arm64'
      })
    ).toMatchObject({
      formatVersion: 1,
      appId: 'com.omniconsole.ide',
      buildId: '1.2.3-local.1-abc123-arm64',
      version: '1.2.3-local.1',
      commit: 'abc123',
      stateSchemaVersion: 1,
      platform: 'darwin',
      architecture: 'arm64',
      releaseBuild: false
    })
  })

  it('stamps releaseBuild true only when the packager says so', () => {
    expect(
      createMacBuildCompatibility({
        version: '1.9.6',
        commit: 'abc123def456',
        architecture: 'arm64',
        releaseBuild: true
      }).releaseBuild
    ).toBe(true)
    expect(() =>
      createMacBuildCompatibility({
        version: '1.9.6',
        commit: 'abc123def456',
        architecture: 'arm64',
        releaseBuild: 'yes'
      })
    ).toThrow('releaseBuild must be a boolean')
  })

  it('rejects unsupported architecture metadata', () => {
    expect(() =>
      createMacBuildCompatibility({
        version: '1.2.3',
        commit: 'abc123',
        architecture: 'universal'
      })
    ).toThrow('Unsupported macOS build architecture')
  })
})
