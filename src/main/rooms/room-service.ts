import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getSecretStore } from '../../shared/secret-store'
import { writeSecureJsonFile } from '../../shared/secure-file'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { RoomClient } from './room-client'
import { RoomCredentialStore } from './room-credential-store'
import { getRoomConfig, type RoomConfiguration } from './room-config'
import { RoomError } from './room-error'
import { RoomPoller } from './room-poller'
import type { RoomSnapshot } from '../../shared/rooms'

export class RoomService {
  readonly credentials: RoomCredentialStore
  readonly client: RoomClient
  private pollers = new Map<string, RoomPoller>()
  constructor(
    readonly config: RoomConfiguration,
    openBrowser: (url: string) => Promise<void>,
    private readonly publish: (roomId: string, snapshot: RoomSnapshot) => void
  ) {
    const file = join(getProfileUserDataPath(), 'rooms', `${config.key}-credential.json`)
    this.credentials = new RoomCredentialStore({
      origins: config,
      binding: config.key,
      platform: process.platform,
      secrets: getSecretStore(),
      isCurrent: config.isCurrent,
      openBrowser,
      vault: {
        read: () => {
          if (!existsSync(file)) {
            return null
          }
          const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
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
        write: (ciphertext) => writeSecureJsonFile(file, { ciphertext }),
        clear: () => rmSync(file, { force: true })
      }
    })
    this.client = new RoomClient(async () => {
      const current = await getRoomConfig()
      if (current.key !== config.key) {
        throw new RoomError('connection_changed')
      }
      return this.credentials.access()
    })
  }
  watch(id: string | null): RoomSnapshot | null {
    for (const [key, poller] of this.pollers) {
      if (key !== id) {
        poller.setVisible(false)
      }
    }
    if (!id) {
      return null
    }
    let poller = this.pollers.get(id)
    if (!poller) {
      // Bound inactive-room retention as well as events within each room.
      if (this.pollers.size >= 8) {
        const oldest = this.pollers.keys().next().value!
        this.pollers.get(oldest)?.dispose()
        this.pollers.delete(oldest)
      }
      poller = new RoomPoller(id, this.client, (snapshot) => this.publish(id, snapshot))
      this.pollers.set(id, poller)
    }
    poller.setVisible(true)
    return poller.current()
  }
  clearHistory() {
    for (const poller of this.pollers.values()) {
      poller.dispose()
    }
    this.pollers.clear()
  }
  dispose() {
    this.clearHistory()
    this.credentials.dispose()
  }
}
