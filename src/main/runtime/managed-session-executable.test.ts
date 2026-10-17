import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveManagedProviderExecutable } from './managed-session-executable'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const options = { platform: 'darwin' as const, arch: 'arm64', uid: process.getuid?.() ?? 0 }
function macho(arch = 'arm64', type = 2): Buffer {
  const bytes = Buffer.alloc(32)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  bytes.writeUInt32LE(type, 12)
  return bytes
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-provider-executable-')))
  roots.push(root)
  const packageRoot = join(root, 'node_modules', '@openai', 'codex')
  const wrapper = join(packageRoot, 'bin', 'codex.js')
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  await writeFile(wrapper, '#!/usr/bin/env node\nthrow new Error("must not execute")\n', {
    mode: 0o755
  })
  const metadata = { name: '@openai/codex', version: '0.160.1', bin: { codex: 'bin/codex.js' } }
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(metadata), { mode: 0o644 })
  const platformRoot = join(root, 'node_modules', '@openai', 'codex-darwin-arm64')
  const binary = join(platformRoot, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex')
  await mkdir(join(platformRoot, 'vendor', 'aarch64-apple-darwin', 'bin'), { recursive: true })
  await writeFile(binary, macho(), { mode: 0o755 })
  await writeFile(
    join(platformRoot, 'package.json'),
    JSON.stringify({ name: '@openai/codex-darwin-arm64', version: '0.160.1' }),
    { mode: 0o644 }
  )
  return { root, packageRoot, wrapper, platformRoot, binary, metadata }
}

// npm installs the platform package as an alias nested under @openai/codex:
// name "@openai/codex", version "<main>-darwin-<arch>" (as on the Mac Studio, 0.160.1).
async function aliasFixture() {
  const f = await fixture()
  await rm(f.platformRoot, { recursive: true })
  const platformRoot = join(f.packageRoot, 'node_modules', '@openai', 'codex-darwin-arm64')
  const binary = join(platformRoot, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex')
  await mkdir(join(platformRoot, 'vendor', 'aarch64-apple-darwin', 'bin'), { recursive: true })
  await writeFile(binary, macho(), { mode: 0o755 })
  const platformMetadata = { name: '@openai/codex', version: '0.160.1-darwin-arm64' }
  await writeFile(join(platformRoot, 'package.json'), JSON.stringify(platformMetadata), {
    mode: 0o644
  })
  return { ...f, platformRoot, binary, platformMetadata }
}

describe.skipIf(process.platform === 'win32')('managed native provider executable', () => {
  it('keeps a direct native executable without adding wrapper configuration', async () => {
    const f = await fixture()
    expect(await resolveManagedProviderExecutable(f.binary, 'codex', options)).toMatchObject({
      executablePath: f.binary,
      environment: {}
    })
  })

  it('resolves installed matching Codex platform metadata without executing its JavaScript', async () => {
    const f = await fixture()
    expect(await resolveManagedProviderExecutable(f.wrapper, 'codex', options)).toMatchObject({
      executablePath: f.binary,
      environment: { CODEX_MANAGED_PACKAGE_ROOT: f.packageRoot }
    })
  })

  it('refuses executable replacement or changed image protection before spawn', async () => {
    const f = await fixture()
    const pinned = await resolveManagedProviderExecutable(f.binary, 'codex', options)
    expect(() => pinned.assertCurrent()).not.toThrow()
    await rm(f.binary)
    await writeFile(f.binary, macho(), { mode: 0o755 })
    expect(() => pinned.assertCurrent()).toThrow('managed_provider_native_executable_unverifiable')
    const current = await resolveManagedProviderExecutable(f.binary, 'codex', options)
    await chmod(f.binary, 0o777)
    expect(() => current.assertCurrent()).toThrow('managed_provider_native_executable_unverifiable')
  })

  it('supports the exact in-package vendor fallback when the platform package is absent', async () => {
    const f = await fixture()
    await rm(f.platformRoot, { recursive: true })
    const binary = join(f.packageRoot, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex')
    await mkdir(join(f.packageRoot, 'vendor', 'aarch64-apple-darwin', 'bin'), { recursive: true })
    await writeFile(binary, macho(), { mode: 0o755 })
    expect(await resolveManagedProviderExecutable(f.wrapper, 'codex', options)).toMatchObject({
      executablePath: binary
    })
  })

  it.each([
    'package-name',
    'package-version',
    'package-bin',
    'platform-version',
    'platform-name',
    'wrong-architecture',
    'not-executable-image',
    'script-payload',
    'world-writable'
  ] as const)('refuses %s without falling back to wrapper execution', async (kind) => {
    const f = await fixture()
    if (kind === 'package-name') {
      f.metadata.name = 'untrusted'
    }
    if (kind === 'package-version') {
      f.metadata.version = ''
    }
    if (kind === 'package-bin') {
      f.metadata.bin.codex = 'another.js'
    }
    await writeFile(join(f.packageRoot, 'package.json'), JSON.stringify(f.metadata))
    if (kind === 'platform-version' || kind === 'platform-name') {
      await writeFile(
        join(f.platformRoot, 'package.json'),
        JSON.stringify({
          name: kind === 'platform-name' ? 'untrusted' : '@openai/codex-darwin-arm64',
          version: kind === 'platform-version' ? '0.159.0' : '0.160.1'
        })
      )
    }
    if (kind === 'wrong-architecture') {
      await writeFile(f.binary, macho('x64'))
    }
    if (kind === 'not-executable-image') {
      await writeFile(f.binary, macho('arm64', 6))
    }
    if (kind === 'script-payload') {
      await writeFile(f.binary, '#!/bin/sh\nexit 0\n')
    }
    if (kind === 'world-writable') {
      await chmod(f.binary, 0o777)
    }
    await expect(resolveManagedProviderExecutable(f.wrapper, 'codex', options)).rejects.toThrow(
      'managed_provider_native_executable_unverifiable'
    )
  })

  it('resolves the npm alias form of the Codex platform package', async () => {
    const f = await aliasFixture()
    const pinned = await resolveManagedProviderExecutable(f.wrapper, 'codex', options)
    expect(pinned).toMatchObject({
      executablePath: f.binary,
      environment: { CODEX_MANAGED_PACKAGE_ROOT: f.packageRoot }
    })
    expect(() => pinned.assertCurrent()).not.toThrow()
  })

  it.each([
    'alias-wrong-version',
    'alias-unsuffixed-version',
    'alias-other-arch',
    'alias-wrong-name',
    'canonical-name-alias-version',
    'script-payload',
    'second-hard-link',
    'group-writable'
  ] as const)('refuses an npm alias platform package with %s', async (kind) => {
    const f = await aliasFixture()
    const metadata: Record<string, string> = { ...f.platformMetadata }
    if (kind === 'alias-wrong-version') {
      metadata.version = '0.159.0-darwin-arm64'
    }
    if (kind === 'alias-unsuffixed-version') {
      metadata.version = '0.160.1'
    }
    if (kind === 'alias-other-arch') {
      metadata.version = '0.160.1-darwin-x64'
    }
    if (kind === 'alias-wrong-name') {
      metadata.name = '@openai/codex-cli'
    }
    if (kind === 'canonical-name-alias-version') {
      metadata.name = '@openai/codex-darwin-arm64'
    }
    await writeFile(join(f.platformRoot, 'package.json'), JSON.stringify(metadata))
    if (kind === 'script-payload') {
      await writeFile(f.binary, '#!/bin/sh\nexit 0\n')
    }
    if (kind === 'second-hard-link') {
      await link(f.binary, join(f.root, 'second-link'))
    }
    if (kind === 'group-writable') {
      await chmod(f.binary, 0o775)
    }
    await expect(resolveManagedProviderExecutable(f.wrapper, 'codex', options)).rejects.toThrow(
      'managed_provider_native_executable_unverifiable'
    )
  })

  it('refuses a vendor symlink escaping the validated package', async () => {
    const f = await fixture()
    const outside = join(f.root, 'outside')
    await writeFile(outside, macho(), { mode: 0o755 })
    await rm(f.binary)
    await symlink(outside, f.binary)
    await expect(resolveManagedProviderExecutable(f.wrapper, 'codex', options)).rejects.toThrow(
      'managed_provider_native_executable_unverifiable'
    )
  })

  it('does not treat arbitrary scripts or Claude wrappers as native executables', async () => {
    const f = await fixture()
    await expect(resolveManagedProviderExecutable(f.wrapper, 'claude', options)).rejects.toThrow(
      'managed_provider_native_executable_unverifiable'
    )
    await expect(resolveManagedProviderExecutable('codex', 'codex', options)).rejects.toThrow(
      'managed_provider_native_executable_unverifiable'
    )
    await expect(
      resolveManagedProviderExecutable(f.binary, 'codex', { ...options, platform: 'linux' })
    ).rejects.toThrow('managed_provider_native_executable_unverifiable')
  })
})
