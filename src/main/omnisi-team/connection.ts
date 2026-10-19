import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getSecretStore } from '../../shared/secret-store'
import { writeCredentialFileAtomic } from '../integration-credential-file'

export type TeamConnection = { server: string; key: string; team: string; installation: string }
export const TEAM_SERVER_NAME = 'omnisi-team'
export const TEAM_AUTH_ENV = 'OMNICONSOLE_OMNISI_AUTHORIZATION'

export function parseTeamConnection(
  server: unknown,
  key: unknown
): { server: string; key: string } {
  if (typeof server !== 'string' || server.length > 16384 || typeof key !== 'string') {
    throw new Error('Enter your server URL and team key.')
  }
  try {
    if (server.trim().startsWith('{')) {
      const imported = JSON.parse(server).mcpServers?.omnisi
      server = imported?.url
      key = imported?.headers?.Authorization?.replace(/^Bearer /, '')
    }
    const url = new URL(server as string)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/mcp'
    ) {
      throw new Error('Invalid server URL.')
    }
    if (typeof key !== 'string' || !/^osc1\.[A-Za-z0-9._-]{8,2048}$/.test(key)) {
      throw new Error('Invalid team key.')
    }
    return { server: url.href, key }
  } catch {
    throw new Error('Use the HTTPS /mcp URL and osc1. team key from your OmniSI connection card.')
  }
}

function protectedStore(): ReturnType<typeof getSecretStore> {
  const store = getSecretStore()
  if (!store.isEncryptionAvailable() || store.describeProtectionGap()) {
    throw new Error('Unlock your OS keychain before connecting to OmniSI.')
  }
  return store
}

export class TeamConnectionStore {
  constructor(private readonly file: string) {}
  read(): TeamConnection | null {
    if (!existsSync(this.file)) {
      return null
    }
    try {
      const value = JSON.parse(
        protectedStore().decryptString(readFileSync(this.file))
      ) as TeamConnection
      parseTeamConnection(value.server, value.key)
      if (typeof value.team !== 'string' || typeof value.installation !== 'string') {
        throw new Error('Invalid saved team connection.')
      }
      return value
    } catch {
      throw new Error(
        'The saved OmniSI connection could not be unlocked. Unlock your OS keychain or disconnect.'
      )
    }
  }
  save(value: Omit<TeamConnection, 'installation'>): TeamConnection {
    const connection = { ...value, installation: randomUUID() }
    const sealed = protectedStore().encryptString(JSON.stringify(connection))
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    writeCredentialFileAtomic(this.file, sealed)
    return connection
  }
  remove(): void {
    if (existsSync(this.file)) {
      unlinkSync(this.file)
    }
  }
}
