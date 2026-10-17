export type ConnectorAccount = {
  id: string
  provider: 'claude' | 'codex'
  label: string
  available: boolean
}

export type ConnectorDefinition = {
  name: string
  transport: 'http' | 'stdio'
  url?: string
  command?: string
  args?: string[]
}

export type ConnectorSummary = {
  name: string
  transport: 'http' | 'stdio' | 'unknown'
  enabled: boolean
}

export type ConnectorStatus =
  | 'connected'
  | 'signed-in'
  | 'needs-sign-in'
  | 'configured'
  | 'unavailable'
export type ConnectorAction = 'check' | 'login' | 'reconnect' | 'remove'

export function validateConnectorName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error('Use a connector name with letters, numbers, dashes or underscores.')
  }
}

export type McpConnectorsApi = {
  accounts: () => Promise<ConnectorAccount[]>
  list: (accountId: string) => Promise<ConnectorSummary[]>
  add: (accountId: string, definition: ConnectorDefinition) => Promise<void>
  action: (accountId: string, name: string, action: ConnectorAction) => Promise<ConnectorStatus>
}

export function validateConnectorDefinition(value: ConnectorDefinition): ConnectorDefinition {
  validateConnectorName(value?.name)
  if (value.transport === 'http') {
    if (typeof value.url !== 'string' || value.url.length > 4096) {
      throw new Error('Enter a server URL.')
    }
    const url = new URL(value.url ?? '')
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error('Enter an HTTP or HTTPS server URL without embedded credentials.')
    }
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('Use HTTPS for servers outside this computer.')
    }
    return { name: value.name, transport: 'http', url: url.href }
  }
  if (
    value.transport !== 'stdio' ||
    typeof value.command !== 'string' ||
    !value.command.trim() ||
    value.command.length > 4096 ||
    /[\r\n\0]/.test(value.command) ||
    !Array.isArray(value.args) ||
    value.args.length > 128 ||
    value.args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))
  ) {
    throw new Error('Enter an executable and a JSON array of arguments.')
  }
  return { name: value.name, transport: 'stdio', command: value.command, args: value.args }
}
