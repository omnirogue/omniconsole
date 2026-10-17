import { createHash, randomBytes } from 'node:crypto'
import type { z } from 'zod'
import type { SecretStore } from '../../shared/secret-store'
import type { RoomAccountStatus, RoomOrigins, RoomErrorCode } from '../../shared/rooms'
import type { RoomAccess } from './room-client'
import { RoomError } from './room-error'
import {
  ROOM_CALLBACK,
  roomDeviceClientId,
  authorizationCode,
  storedCredential,
  requestDeviceToken,
  revokeDeviceToken
} from './room-device-token'
export { ROOM_CALLBACK } from './room-device-token'

export type RoomCredentialOptions = {
  origins: RoomOrigins
  binding: string
  platform: NodeJS.Platform
  secrets: SecretStore
  vault: {
    read(): string | null
    write(ciphertext: string): void
    clear(): void
  }
  isCurrent(): boolean
  openBrowser(url: string): Promise<void>
  fetcher?: typeof fetch
  now?: () => number
}

/** The only token accessor is the main-only access lease. IPC returns status projections. */
export class RoomCredentialStore {
  #credential: z.infer<typeof storedCredential> | null = null
  #pending: {
    state: string
    verifier: string
    at: number
    generation: number
  } | null = null
  #generation = 0
  #loaded = false
  #refreshing: Promise<void> | undefined
  #exchanging: number | null = null
  #error: RoomErrorCode | undefined
  private readonly now: () => number
  private readonly fetcher: typeof fetch
  constructor(private readonly options: RoomCredentialOptions) {
    this.now = options.now ?? Date.now
    this.fetcher = options.fetcher ?? fetch
  }
  private assertCurrent() {
    if (!this.options.isCurrent()) {
      throw new RoomError('connection_changed')
    }
  }
  private assertSecure() {
    const secrets = this.options.secrets
    if (!secrets.isEncryptionAvailable() || secrets.describeProtectionGap()) {
      throw new RoomError('secure_storage_unavailable')
    }
  }
  private load() {
    this.assertCurrent()
    if (this.#loaded) {
      return
    }
    this.assertSecure()
    try {
      const ciphertext = this.options.vault.read()
      if (ciphertext) {
        const value = storedCredential.parse(
          JSON.parse(this.options.secrets.decryptString(Buffer.from(ciphertext, 'base64')))
        )
        if (value.binding === this.options.binding) {
          this.#credential = value
        }
      }
      this.#loaded = true
    } catch {
      throw new RoomError('storage_error')
    }
  }
  status(): RoomAccountStatus {
    this.load()
    if (this.#pending && this.now() - this.#pending.at >= 600000) {
      this.#pending = null
    }
    return this.#pending || this.#exchanging
      ? { state: 'linking' }
      : this.#credential && this.#credential.expiresAt > this.now()
        ? { state: 'linked', expiresAt: this.#credential.expiresAt }
        : { state: 'unlinked', ...(this.#error ? { error: this.#error } : {}) }
  }
  async link(): Promise<RoomAccountStatus> {
    if (this.status().state === 'linked') {
      return this.status()
    }
    this.assertSecure()
    this.#error = undefined
    const pending = {
      state: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'),
      at: this.now(),
      generation: ++this.#generation
    }
    this.#pending = pending
    const url = new URL('/omniconsole/connect', this.options.origins.frontendOrigin)
    url.search = new URLSearchParams({
      client_id: roomDeviceClientId(this.options.platform),
      redirect_uri: ROOM_CALLBACK,
      response_type: 'code',
      code_challenge_method: 'S256',
      state: pending.state,
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url')
    }).toString()
    try {
      await this.options.openBrowser(url.href)
      this.assertCurrent()
    } catch {
      this.#pending = null
      throw new RoomError('network_error')
    }
    return this.status()
  }
  async acceptCallback(raw: string): Promise<RoomAccountStatus> {
    const pending = this.#pending
    if (!pending) {
      return this.status()
    }
    this.#pending = null
    this.assertCurrent()
    if (this.now() < pending.at || this.now() - pending.at >= 600000) {
      throw new RoomError('link_expired')
    }
    const code = authorizationCode(raw, pending.state)
    const issuedAt = this.now()
    this.#exchanging = pending.generation
    let parsed
    try {
      parsed = await requestDeviceToken(this.fetcher, this.options.origins.apiOrigin, 'token', {
        grant_type: 'authorization_code',
        client_id: roomDeviceClientId(this.options.platform),
        redirect_uri: ROOM_CALLBACK,
        code,
        code_verifier: pending.verifier
      })
    } finally {
      if (this.#exchanging === pending.generation) {
        this.#exchanging = null
      }
    }
    const token = parsed.access_token
    try {
      this.assertCurrent()
      if (this.#generation !== pending.generation) {
        throw new RoomError('connection_changed')
      }
      this.assertSecure()
      const credential = {
        token,
        refreshToken: parsed.refresh_token,
        expiresAt: issuedAt + parsed.expires_in * 1000,
        binding: this.options.binding
      }
      if (credential.expiresAt <= this.now()) {
        throw new RoomError('link_expired')
      }
      this.saveCredential(credential)
      return this.status()
    } catch (error) {
      await this.revoke(token).catch(() => undefined)
      throw error
    }
  }
  access(): RoomAccess {
    if (this.status().state !== 'linked' || !this.#credential) {
      throw new RoomError('device_unauthorized')
    }
    const credential = this.#credential,
      generation = this.#generation
    return {
      token: credential.token,
      apiOrigin: this.options.origins.apiOrigin,
      check: () => {
        this.assertCurrent()
        if (
          generation !== this.#generation ||
          credential !== this.#credential ||
          credential.expiresAt <= this.now()
        ) {
          throw new RoomError('device_unauthorized')
        }
      }
    }
  }
  private saveCredential(credential: z.infer<typeof storedCredential>) {
    this.assertSecure()
    const ciphertext = this.options.secrets
      .encryptString(JSON.stringify(credential))
      .toString('base64')
    try {
      this.options.vault.write(ciphertext)
    } catch {
      throw new RoomError('storage_error')
    }
    this.#credential = credential
  }
  async leaseAccess(rejectedToken?: string): Promise<RoomAccess> {
    this.load()
    const credential = this.#credential
    if (
      credential?.refreshToken &&
      !this.#pending &&
      !this.#exchanging &&
      (credential.expiresAt <= this.now() + 5 * 60_000 || rejectedToken === credential.token)
    ) {
      if (!this.#refreshing) {
        const task = this.refresh(credential).finally(() => {
          if (this.#refreshing === task) {
            this.#refreshing = undefined
          }
        })
        this.#refreshing = task
      }
      await this.#refreshing
    }
    return this.access()
  }
  private async refresh(credential: z.infer<typeof storedCredential>): Promise<void> {
    const generation = this.#generation,
      issuedAt = this.now()
    const parsed = await requestDeviceToken(
      this.fetcher,
      this.options.origins.apiOrigin,
      'refresh',
      {
        grant_type: 'refresh_token',
        client_id: roomDeviceClientId(this.options.platform),
        refresh_token: credential.refreshToken
      }
    )
    try {
      this.assertCurrent()
      if (generation !== this.#generation || credential !== this.#credential) {
        throw new RoomError('connection_changed')
      }
      const expiresAt = issuedAt + parsed.expires_in * 1000
      if (expiresAt <= this.now()) {
        throw new RoomError('link_expired')
      }
      this.saveCredential({
        ...credential,
        token: parsed.access_token,
        refreshToken: parsed.refresh_token ?? credential.refreshToken,
        expiresAt
      })
    } catch (error) {
      await this.revoke(parsed.access_token).catch(() => undefined)
      throw error
    }
  }
  private revoke(token: string) {
    return revokeDeviceToken(this.fetcher, this.options.origins.apiOrigin, token)
  }
  async unlink(): Promise<RoomAccountStatus> {
    this.load()
    this.#generation++
    this.#pending = null
    this.#error = undefined
    if (this.#credential && this.#credential.expiresAt > this.now()) {
      await this.revoke(this.#credential.token)
    }
    this.assertCurrent()
    try {
      this.options.vault.clear()
    } catch {
      throw new RoomError('storage_error')
    }
    this.#credential = null
    return { state: 'unlinked' }
  }
  recordLinkError(code: RoomErrorCode) {
    this.#error = code
  }
  dispose() {
    this.#generation++
    this.#pending = null
    this.#credential = null
  }
}
