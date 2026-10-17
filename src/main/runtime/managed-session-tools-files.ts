import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'

const Identifier = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)
const Descriptor = z
  .object({
    schema: z.literal('native-session-tools.v1'),
    operation_id: Identifier,
    native_operation_id: z.string().regex(/^\d{13}-[0-9a-f]{32}$/),
    provider: z.enum(['claude', 'codex', 'auto']),
    command: z.literal('/usr/bin/python3'),
    args: z.tuple([z.string(), z.string()]),
    principal: z.object({ clerk_user_id: Identifier, employee_id: Identifier }).strict()
  })
  .strict()

export type ManagedSessionToolsDescriptor = Omit<z.infer<typeof Descriptor>, 'provider'> & {
  provider: 'claude' | 'codex'
}
export type ManagedSessionToolsFiles = {
  descriptor: ManagedSessionToolsDescriptor
  mcpConfigPath: string
  assertCurrent: () => void
  writeMcpConfig: (value: unknown) => void
}

function refuse(): never {
  // Never include file contents: the neighbouring config contains a bearer token.
  throw new Error('managed_session_tools_file_untrusted')
}

function assertDirectories(path: string, home: string, uid: number): void {
  const rel = relative(home, path)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    refuse()
  }
  let cursor = dirname(path)
  while (true) {
    const stat = lstatSync(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.mode & 0o022) {
      refuse()
    }
    if (cursor === home) {
      break
    }
    cursor = dirname(cursor)
  }
}

export function readPrivateManagedFile(path: string, home: string, executable = false): Buffer {
  const uid = process.getuid?.()
  if (uid === undefined || !isAbsolute(path) || resolve(path) !== path) {
    refuse()
  }
  assertDirectories(path, home, uid)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    const mode = stat.mode & 0o777
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== uid ||
      (mode !== 0o600 && !(executable && mode === 0o700)) ||
      stat.size > 128 * 1024
    ) {
      refuse()
    }
    const contents = readFileSync(fd)
    if (contents.byteLength !== stat.size) {
      refuse()
    }
    return contents
  } finally {
    closeSync(fd)
  }
}

function fingerprint(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Reads only the fixed host-owned configuration. A request cannot nominate a trust root. */
export function readManagedSessionToolsFiles(
  file: string,
  expected: { nativeOperationId: string; provider: string },
  home = homedir()
): ManagedSessionToolsFiles {
  try {
    const hostConfigPath = join(home, '.config/omni/ai-operations-host.json')
    const hostContents = readPrivateManagedFile(hostConfigPath, home)
    const hostConfig = JSON.parse(hostContents.toString('utf8')) as { state_dir?: unknown }
    if (typeof hostConfig.state_dir !== 'string' || !isAbsolute(hostConfig.state_dir)) {
      refuse()
    }
    const root = join(hostConfig.state_dir, 'session-tools')
    const contents = readPrivateManagedFile(file, home)
    const parsed = Descriptor.safeParse(JSON.parse(contents.toString('utf8')))
    if (!parsed.success) {
      refuse()
    }
    const descriptor = parsed.data
    const operationDir = join(root, descriptor.operation_id)
    if (
      file !== join(operationDir, 'descriptor.json') ||
      descriptor.native_operation_id !== expected.nativeOperationId ||
      !['claude', 'codex'].includes(expected.provider) ||
      (descriptor.provider !== 'auto' && descriptor.provider !== expected.provider) ||
      descriptor.args[0] !== join(root, 'native_tools_mcp.py') ||
      descriptor.args[1] !== join(operationDir, 'config.json')
    ) {
      refuse()
    }
    const shim = readPrivateManagedFile(descriptor.args[0], home, true)
    readPrivateManagedFile(descriptor.args[1], home)
    const expectedHash = fingerprint(contents)
    const shimHash = fingerprint(shim)
    const hostHash = fingerprint(hostContents)
    const mcpConfigPath = join(operationDir, 'claude-mcp.json')
    let mcpHash: string | undefined
    return {
      descriptor: { ...descriptor, provider: expected.provider as 'claude' | 'codex' },
      mcpConfigPath,
      writeMcpConfig: (value) => {
        writeDurableSecureJsonFile(mcpConfigPath, value)
        mcpHash = fingerprint(readPrivateManagedFile(mcpConfigPath, home))
      },
      assertCurrent: () => {
        if (
          fingerprint(readPrivateManagedFile(hostConfigPath, home)) !== hostHash ||
          fingerprint(readPrivateManagedFile(file, home)) !== expectedHash ||
          fingerprint(readPrivateManagedFile(descriptor.args[0], home, true)) !== shimHash
        ) {
          refuse()
        }
        if (
          mcpHash !== undefined &&
          fingerprint(readPrivateManagedFile(mcpConfigPath, home)) !== mcpHash
        ) {
          refuse()
        }
        // Token renewal may replace config content, but never its protection or location.
        readPrivateManagedFile(descriptor.args[1], home)
      }
    }
  } catch {
    refuse()
  }
}
