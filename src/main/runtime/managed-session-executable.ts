import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ManagedSessionProvider } from './managed-session-process'

type ExecutableOptions = {
  platform?: NodeJS.Platform
  arch?: string
  uid?: number
  resolvePackage?: (name: string, from: string) => string
}
export type ManagedProviderExecutable = {
  executablePath: string
  environment: Record<string, string>
  assertCurrent: () => void
}

function refused(): never {
  throw new Error('managed_provider_native_executable_unverifiable')
}

async function readOwned(
  path: string,
  uid: number,
  limit: number,
  executable: boolean
): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (
      !info.isFile() ||
      (info.uid !== uid && info.uid !== 0) ||
      (info.mode & 0o022) !== 0 ||
      (executable && (info.mode & 0o111) === 0) ||
      info.nlink !== 1
    ) {
      refused()
    }
    if (!executable && info.size > limit) {
      refused()
    }
    const bytes = Buffer.alloc(Math.min(info.size, limit))
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== bytes.length) {
      refused()
    }
    return bytes
  } finally {
    await handle.close()
  }
}

function isNativeExecutable(header: Buffer, arch: string): boolean {
  if (header.length < 32) {
    return false
  }
  // Thin 64-bit Mach-O: the kernel receives the provider, never a script interpreter.
  const magic = header.readUInt32LE(0)
  const read =
    magic === 0xfeedfacf
      ? (offset: number) => header.readUInt32LE(offset)
      : magic === 0xcffaedfe
        ? (offset: number) => header.readUInt32BE(offset)
        : null
  return Boolean(read && read(4) === (arch === 'arm64' ? 0x0100000c : 0x01000007) && read(12) === 2)
}

function pinnedExecutable(
  executablePath: string,
  environment: Record<string, string>,
  uid: number,
  arch: string
): ManagedProviderExecutable {
  const identity = (): string => {
    if (realpathSync(executablePath) !== executablePath) {
      refused()
    }
    const fd = openSync(
      executablePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const before = fstatSync(fd, { bigint: true })
      if (
        !before.isFile() ||
        (before.uid !== BigInt(uid) && before.uid !== 0n) ||
        (before.mode & 0o022n) !== 0n ||
        (before.mode & 0o111n) === 0n ||
        before.nlink !== 1n
      ) {
        refused()
      }
      const header = Buffer.alloc(32)
      if (readSync(fd, header, 0, 32, 0) !== 32 || !isNativeExecutable(header, arch)) {
        refused()
      }
      const after = fstatSync(fd, { bigint: true })
      const fingerprint = (info: typeof before) =>
        [
          info.dev,
          info.ino,
          info.size,
          info.mtimeNs,
          info.ctimeNs,
          info.mode,
          info.uid,
          info.gid,
          info.nlink
        ].join(':')
      if (fingerprint(before) !== fingerprint(after)) {
        refused()
      }
      return `${fingerprint(after)}:${header.toString('hex')}`
    } finally {
      closeSync(fd)
    }
  }
  const expected = identity()
  return {
    executablePath,
    environment,
    assertCurrent: () => {
      try {
        if (identity() !== expected) {
          refused()
        }
      } catch {
        refused()
      }
    }
  }
}

async function packageMetadata(path: string, uid: number): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse((await readOwned(path, uid, 65_536, false)).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refused()
  }
  return value as Record<string, unknown>
}

async function nativeInPackage(
  root: string,
  path: string,
  uid: number,
  arch: string
): Promise<string> {
  const canonical = await realpath(path)
  const rel = relative(root, canonical)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    refused()
  }
  if (!isNativeExecutable(await readOwned(canonical, uid, 32, true), arch)) {
    refused()
  }
  return canonical
}

/** Resolve a fixed managed launch to a native image without executing or trusting a wrapper's output. */
export async function resolveManagedProviderExecutable(
  resolvedPath: string,
  provider: ManagedSessionProvider,
  options: ExecutableOptions = {}
): Promise<ManagedProviderExecutable> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const uid = options.uid ?? process.getuid?.()
  if (
    platform !== 'darwin' ||
    !['arm64', 'x64'].includes(arch) ||
    uid === undefined ||
    !isAbsolute(resolvedPath)
  ) {
    refused()
  }
  try {
    const canonical = await realpath(resolvedPath)
    const header = await readOwned(canonical, uid, 32, true)
    if (isNativeExecutable(header, arch)) {
      return pinnedExecutable(canonical, {}, uid, arch)
    }
    if (
      provider !== 'codex' ||
      basename(canonical) !== 'codex.js' ||
      basename(dirname(canonical)) !== 'bin'
    ) {
      refused()
    }
    const root = dirname(dirname(canonical))
    const metadata = await packageMetadata(join(root, 'package.json'), uid)
    const version = metadata.version
    const bin = metadata.bin as Record<string, unknown> | undefined
    if (
      metadata.name !== '@openai/codex' ||
      typeof version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version) ||
      !bin ||
      bin.codex !== 'bin/codex.js'
    ) {
      refused()
    }
    const packageName = `@openai/codex-darwin-${arch}`
    const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    let platformRoot: string | null = null
    try {
      const resolved = (
        options.resolvePackage ?? ((name, from) => createRequire(from).resolve(name))
      )(`${packageName}/package.json`, join(root, 'package.json'))
      const packagePath = await realpath(resolved)
      const platformMetadata = await packageMetadata(packagePath, uid)
      // Two exact forms only: the canonical package, and the npm alias the published
      // @openai/codex installs it as (`"@openai/codex-darwin-arm64": "npm:@openai/codex@<v>-darwin-arm64"`),
      // whose package.json keeps the main name with an arch-suffixed version.
      const canonicalForm =
        platformMetadata.name === packageName && platformMetadata.version === version
      const npmAliasForm =
        platformMetadata.name === '@openai/codex' &&
        platformMetadata.version === `${version}-darwin-${arch}`
      if (!canonicalForm && !npmAliasForm) {
        refused()
      }
      platformRoot = dirname(packagePath)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'MODULE_NOT_FOUND') {
        throw error
      }
    }
    const vendorRoot = platformRoot ?? root
    // An installed but invalid platform package cannot silently select another binary.
    const executablePath = await nativeInPackage(
      vendorRoot,
      join(vendorRoot, 'vendor', triple, 'bin', 'codex'),
      uid,
      arch
    )
    const directory = await stat(vendorRoot)
    if (
      !directory.isDirectory() ||
      (directory.uid !== uid && directory.uid !== 0) ||
      (directory.mode & 0o022) !== 0
    ) {
      refused()
    }
    return pinnedExecutable(executablePath, { CODEX_MANAGED_PACKAGE_ROOT: root }, uid, arch)
  } catch {
    return refused()
  }
}
