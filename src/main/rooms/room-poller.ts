import type { RoomSnapshot } from '../../shared/rooms'
import type { RoomClient } from './room-client'
import { roomErrorCode } from './room-error'

export class RoomPoller {
  private snapshot: RoomSnapshot = { events: [], sequence: '0', gaps: [], retryMs: 2000 }
  private cold = true
  private visible = false
  private generation = 0
  private failures = 0
  private timer?: ReturnType<typeof setTimeout>
  constructor(
    private readonly roomId: string,
    private readonly client: Pick<RoomClient, 'events'>,
    private readonly publish: (snapshot: RoomSnapshot) => void
  ) {}
  current(): RoomSnapshot {
    return structuredClone(this.snapshot)
  }
  setVisible(visible: boolean) {
    if (this.visible === visible) {
      return
    }
    this.visible = visible
    this.generation++
    clearTimeout(this.timer)
    if (visible) {
      void this.poll(this.generation)
    }
  }
  private async poll(generation: number) {
    try {
      const page = await this.client.events(
        this.roomId,
        this.cold ? 'latest' : this.snapshot.sequence
      )
      if (!this.visible || generation !== this.generation) {
        return
      }
      let previous: bigint | null = this.cold ? null : BigInt(this.snapshot.sequence)
      for (const event of page.events) {
        const next = BigInt(event.sequence)
        if (previous !== null && next <= previous) {
          continue
        }
        if (previous !== null && next > previous + 1n) {
          this.snapshot.gaps.push({ expected: String(previous + 1n), received: event.sequence })
        }
        this.snapshot.events.push(event)
        this.snapshot.sequence = event.sequence
        previous = next
      }
      this.cold = false
      this.snapshot.events = this.snapshot.events.slice(-500)
      this.snapshot.gaps = this.snapshot.gaps.slice(-20)
      this.failures = 0
      delete this.snapshot.error
      this.snapshot.retryMs = 2000
    } catch (error) {
      if (!this.visible || generation !== this.generation) {
        return
      }
      this.snapshot.error = roomErrorCode(error)
      if (
        ['device_unauthorized', 'forbidden', 'connection_changed'].includes(this.snapshot.error)
      ) {
        this.snapshot.events = []
        this.snapshot.gaps = []
        this.snapshot.sequence = '0'
        this.cold = true
      }
      this.snapshot.retryMs = Math.min(30000, 2000 * 2 ** Math.min(this.failures++, 4))
    }
    this.publish(this.current())
    if (this.visible && generation === this.generation) {
      this.timer = setTimeout(() => void this.poll(generation), this.snapshot.retryMs)
    }
  }
  dispose() {
    this.setVisible(false)
    this.snapshot.events = []
    this.snapshot.gaps = []
  }
}
