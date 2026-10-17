import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { OmniRogueAccountState } from '../../shared/omnirogue-account'
import { writeSecureJsonFile } from '../../shared/secure-file'
import { getSecretStore } from '../../shared/secret-store'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { getRoomConfig, type RoomConfiguration } from '../rooms/room-config'
import { ROOM_CALLBACK, RoomCredentialStore } from '../rooms/room-credential-store'
import { RoomError } from '../rooms/room-error'
import { roomRequest } from '../rooms/room-request'

const DEFAULT_OMNIROGUE_API_ORIGIN = 'https://api.omnirogue.com'
const DEFAULT_OMNIROGUE_FRONTEND_ORIGIN = 'https://omnirogue.com'

export type OmniRogueAccountLeaseOptions = {
  openBrowser?: (url: string) => Promise<void>
  resolveConfig?: () => Promise<RoomConfiguration>
  fetcher?: typeof fetch
}

function createFallbackRoomConfig(): RoomConfiguration {
  const key = createHash('sha256')
    .update(`omnirogue:${DEFAULT_OMNIROGUE_API_ORIGIN}:${DEFAULT_OMNIROGUE_FRONTEND_ORIGIN}`)
    .digest('hex')
  return {
    mode: 'fallback',
    key,
    apiOrigin: DEFAULT_OMNIROGUE_API_ORIGIN,
    frontendOrigin: DEFAULT_OMNIROGUE_FRONTEND_ORIGIN,
    isCurrent: () => true
  }
}

async function resolveDefaultRoomConfig(): Promise<RoomConfiguration> {
  try {
    return await getRoomConfig()
  } catch {
    return createFallbackRoomConfig()
  }
}

async function defaultOpenBrowser(_url: string): Promise<void> {
  throw new RoomError('network_error')
}

function buildOmniRogueCredentialStore(
  config: RoomConfiguration,
  openBrowser: (url: string) => Promise<void>,
  fetcher: typeof fetch
): RoomCredentialStore {
  return new RoomCredentialStore({
    origins: {
      apiOrigin: config.apiOrigin,
      frontendOrigin: config.frontendOrigin
    },
    binding: config.key,
    platform: process.platform,
    secrets: getSecretStore(),
    isCurrent: config.isCurrent,
    openBrowser,
    fetcher,
    vault: {
      read: () => {
        const path = join(getProfileUserDataPath(), 'rooms', 'omnirogue-account-credentials.json')
        if (!existsSync(path)) {
          return null
        }
        const payload = readFileSync(path, 'utf8')
        const value: unknown = payload.trimStart().startsWith('{')
          ? JSON.parse(payload)
          : { ciphertext: payload }
        if (
          !value ||
          typeof value !== 'object' ||
          !('ciphertext' in value) ||
          typeof value.ciphertext !== 'string'
        ) {
          throw new RoomError('storage_error')
        }
        return value.ciphertext
      },
      write: (payload) => {
        const path = join(getProfileUserDataPath(), 'rooms', 'omnirogue-account-credentials.json')
        writeSecureJsonFile(path, { ciphertext: payload })
      },
      clear: () => {
        const path = join(getProfileUserDataPath(), 'rooms', 'omnirogue-account-credentials.json')
        rmSync(path, { force: true })
      }
    }
  })
}

export class OmniRogueAccountLease {
  private store: RoomCredentialStore | undefined
  private activeConfig: RoomConfiguration | undefined
  private injectedStore: RoomCredentialStore | undefined
  private openBrowserFn: (url: string) => Promise<void>
  private readonly resolveConfigFn: () => Promise<RoomConfiguration>
  private readonly fetcher: typeof fetch

  constructor(options: OmniRogueAccountLeaseOptions = {}) {
    this.fetcher = options.fetcher ?? fetch
    this.openBrowserFn = options.openBrowser ?? defaultOpenBrowser
    this.resolveConfigFn = options.resolveConfig ?? resolveDefaultRoomConfig
  }

  setOpenBrowser(openBrowser: (url: string) => Promise<void>): void {
    this.openBrowserFn = openBrowser
  }

  setStore(store: RoomCredentialStore | undefined): void {
    this.store?.dispose()
    this.store = undefined
    this.activeConfig = undefined
    this.injectedStore = store
  }

  private async ensureStore(): Promise<{
    store: RoomCredentialStore
    config: RoomConfiguration
  }> {
    const config = await this.resolveConfigFn()
    if (this.injectedStore) {
      return { store: this.injectedStore, config }
    }
    if (
      !this.store ||
      !this.activeConfig ||
      this.activeConfig.key !== config.key ||
      !this.activeConfig.isCurrent()
    ) {
      this.store?.dispose()
      this.activeConfig = config
      this.store = buildOmniRogueCredentialStore(
        config,
        (url) => this.openBrowserFn(url),
        this.fetcher
      )
    }
    return { store: this.store, config: this.activeConfig }
  }

  async status(): Promise<OmniRogueAccountState> {
    const { store, config } = await this.ensureStore()
    await store.leaseAccess().catch(() => undefined)
    const base = store.status()
    return {
      ...base,
      connected: base.state === 'linked',
      omnisiLinked: base.state === 'linked',
      unifiedMcpLinked: base.state === 'linked',
      apiOrigin: config.apiOrigin,
      frontendOrigin: config.frontendOrigin
    }
  }

  async requireToken(): Promise<string> {
    const { store } = await this.ensureStore()
    return (await store.leaseAccess()).token
  }

  async request(path: string): Promise<unknown> {
    const { store } = await this.ensureStore()
    let access = await store.leaseAccess()
    const url = new URL(path, access.apiOrigin)
    if (url.origin !== new URL(access.apiOrigin).origin || url.username || url.password) {
      throw new RoomError('invalid_request')
    }
    const send = async () => {
      access.check()
      const result = await roomRequest(this.fetcher, url.href, {
        token: access.token
      })
      access.check()
      return result
    }
    try {
      return await send()
    } catch (error) {
      if (!(error instanceof RoomError && error.code === 'device_unauthorized')) {
        throw error
      }
      access = await store.leaseAccess(access.token)
      return send()
    }
  }

  async leaseToken(): Promise<string | null> {
    try {
      return await this.requireToken()
    } catch {
      return null
    }
  }

  async link(openBrowser?: (url: string) => Promise<void>): Promise<OmniRogueAccountState> {
    if (openBrowser) {
      this.openBrowserFn = openBrowser
    }
    const { store, config } = await this.ensureStore()
    const base = await store.link()
    return {
      ...base,
      connected: base.state === 'linked',
      omnisiLinked: base.state === 'linked',
      unifiedMcpLinked: base.state === 'linked',
      apiOrigin: config.apiOrigin,
      frontendOrigin: config.frontendOrigin
    }
  }

  async unlink(): Promise<OmniRogueAccountState> {
    const { store, config } = await this.ensureStore()
    const base = await store.unlink()
    return {
      ...base,
      connected: false,
      omnisiLinked: false,
      unifiedMcpLinked: false,
      apiOrigin: config.apiOrigin,
      frontendOrigin: config.frontendOrigin
    }
  }

  async acceptCallback(rawUrl: string): Promise<OmniRogueAccountState> {
    if (!rawUrl.startsWith(`${ROOM_CALLBACK}?`)) {
      throw new RoomError('invalid_callback')
    }
    const { store, config } = await this.ensureStore()
    const base = await store.acceptCallback(rawUrl)
    return {
      ...base,
      connected: base.state === 'linked',
      omnisiLinked: base.state === 'linked',
      unifiedMcpLinked: base.state === 'linked',
      apiOrigin: config.apiOrigin,
      frontendOrigin: config.frontendOrigin
    }
  }

  dispose(): void {
    this.store?.dispose()
    this.store = undefined
    this.activeConfig = undefined
  }
}

const sharedAccountLease = new OmniRogueAccountLease()

export function getSharedOmniRogueAccountLease(): OmniRogueAccountLease {
  return sharedAccountLease
}

export function setOmniRogueAccountLeaseStore(store: RoomCredentialStore | undefined): void {
  sharedAccountLease.setStore(store)
}

export async function getOmniRogueAccountStatus(): Promise<OmniRogueAccountState> {
  return sharedAccountLease.status()
}

export async function leaseOmniRogueToken(): Promise<string | null> {
  return sharedAccountLease.leaseToken()
}

export async function requireOmniRogueToken(): Promise<string> {
  return sharedAccountLease.requireToken()
}
