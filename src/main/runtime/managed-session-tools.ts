import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  runProcess,
  type ProcessResult,
  type ProcessSpec
} from '../../shared/child-process/run-process'
import { resolveCodexCommand } from '../../shared/codex-cli-resolution'
import { findFirstExecutable, splitPath } from '../../shared/node-cli-command-resolution'
import { quoteStartupArg, tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import {
  readManagedSessionToolsFiles,
  type ManagedSessionToolsFiles
} from './managed-session-tools-files'
import { resolveManagedProviderExecutable } from './managed-session-executable'

export type PreparedManagedSessionTools = ManagedSessionToolsFiles & {
  command: string
  environment: Record<string, string>
  agentArgs: string
  seededProviderSessionId: string | null
}

function refuse(reason: string): never {
  throw new Error(`managed_session_tools_${reason}`)
}

export function managedProviderDefaults(provider: 'claude' | 'codex', args: string): string[] {
  const parsed = tokenizeStartupCommand(args, 'posix')
  if (!parsed.ok || parsed.spans.some((span) => span.divergesFromShell)) {
    refuse('unmodelled_defaults')
  }
  const tokens = parsed.tokens
  const conflicting =
    provider === 'claude'
      ? /^(--mcp-config|--strict-mcp-config|--session-id|--resume|--continue|--fork-session|--bare|--setting-sources|--settings|--plugin-dir)(=|$)/
      : /^(--mcp|--remote|--oss|--local-provider|--cd|-C|--enable)(=|$)/
  if (tokens.some((token) => conflicting.test(token))) {
    refuse('conflicting_defaults')
  }
  if (
    provider === 'codex' &&
    tokens.some((token) =>
      /(?:mcp_servers|features\.(?:apps|plugins)|config_file|codex_home)/i.test(token)
    )
  ) {
    refuse('conflicting_defaults')
  }
  // A subcommand/resume supplied as default arguments would not be a fresh launch.
  if (tokens.includes('resume') || tokens.includes('fork') || tokens.includes('--')) {
    refuse('conflicting_defaults')
  }
  return tokens
}

function codexProbeDefaults(tokens: string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (['-c', '--config', '-p', '--profile', '--disable'].includes(token)) {
      const value = tokens[++index]
      if (!value || value.startsWith('-')) {
        refuse('invalid_defaults')
      }
      result.push(token, value)
    } else if (/^(?:--config|--profile|--disable)=/.test(token)) {
      result.push(token)
    } else if (/^-[cp].+/.test(token)) {
      result.push(token)
    }
  }
  return result
}

async function codexServers(
  program: string,
  args: string[],
  context: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
  run: (spec: ProcessSpec) => Promise<ProcessResult>
): Promise<{ name: string; enabled: boolean }[]> {
  const result = await run({
    program,
    args: [...args, 'mcp', 'list', '--json'],
    ...context,
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
    terminationBarrier: true
  })
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
    refuse('codex_config_unverifiable')
  }
  let rows: unknown
  try {
    rows = JSON.parse(result.stdout)
  } catch {
    refuse('codex_config_unverifiable')
  }
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) =>
        !row ||
        typeof row.name !== 'string' ||
        !/^[A-Za-z0-9_-]+$/.test(row.name) ||
        typeof row.enabled !== 'boolean'
    )
  ) {
    refuse('codex_config_unverifiable')
  }
  return rows
}

export async function prepareManagedSessionTools(
  input: {
    file: string
    nativeOperationId: string
    provider: string
    agentArgs: string | null | undefined
    commandOverride: string | undefined
    selectedAccountEnv: Record<string, string>
    startupEnv: Record<string, string>
    cwd: string
    signal?: AbortSignal
  },
  dependencies: {
    readFiles?: typeof readManagedSessionToolsFiles
    run?: (spec: ProcessSpec) => Promise<ProcessResult>
    resolveProgram?: (provider: 'claude' | 'codex') => string
    resolveExecutable?: typeof resolveManagedProviderExecutable
  } = {}
): Promise<PreparedManagedSessionTools> {
  if (input.provider !== 'claude' && input.provider !== 'codex') {
    refuse('provider_unsupported')
  }
  if (input.commandOverride) {
    refuse('custom_command_unsupported')
  }
  const provider = input.provider
  const profileKey = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
  if (!isAbsolute(input.selectedAccountEnv[profileKey] ?? '')) {
    refuse('verified_account_required')
  }
  const files = (dependencies.readFiles ?? readManagedSessionToolsFiles)(input.file, {
    nativeOperationId: input.nativeOperationId,
    provider
  })
  const resolvedCommand =
    dependencies.resolveProgram?.(provider) ??
    (provider === 'codex'
      ? resolveCodexCommand()
      : (findFirstExecutable(process.platform, splitPath(process.env.PATH), ['claude']) ?? ''))
  if (!isAbsolute(resolvedCommand)) {
    refuse('provider_command_unverifiable')
  }
  const executable = await (dependencies.resolveExecutable ?? resolveManagedProviderExecutable)(
    resolvedCommand,
    provider
  )
  const command = executable.executablePath
  const tokens = managedProviderDefaults(provider, input.agentArgs ?? '')
  const server = { command: files.descriptor.command, args: files.descriptor.args }
  let append: string[]
  let seededProviderSessionId: string | null = null
  if (provider === 'claude') {
    files.writeMcpConfig({ mcpServers: { omni_native: server } })
    seededProviderSessionId = randomUUID()
    // The seeded ID belongs to the initial command only, never its saved resume command.
    append = ['--strict-mcp-config', '--mcp-config', files.mcpConfigPath]
  } else {
    const context = {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...executable.environment,
        ...input.startupEnv,
        ...input.selectedAccountEnv
      },
      signal: input.signal
    }
    const run = dependencies.run ?? runProcess
    const probeArgs = codexProbeDefaults(tokens)
    const existing = await codexServers(command, probeArgs, context, run)
    const isolation = [
      '--disable',
      'apps',
      '--disable',
      'plugins',
      ...existing.flatMap(({ name }) => ['-c', `mcp_servers.${name}.enabled=false`]),
      '-c',
      `mcp_servers.omni_native={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)},enabled=true,required=true}`
    ]
    const verified = await codexServers(command, [...probeArgs, ...isolation], context, run)
    const enabled = verified.filter((row) => row.enabled)
    if (enabled.length !== 1 || enabled[0].name !== 'omni_native') {
      refuse('codex_isolation_unverifiable')
    }
    append = isolation
  }
  const assertCurrent = () => {
    files.assertCurrent()
    executable.assertCurrent()
  }
  assertCurrent()
  return {
    ...files,
    assertCurrent,
    command,
    environment: executable.environment,
    seededProviderSessionId,
    agentArgs: [...tokens, ...append].map((token) => quoteStartupArg(token, 'posix')).join(' ')
  }
}
