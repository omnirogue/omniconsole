/**
 * Ownership receipts and permanent revocations per session (or folder) key, saved with the
 * history file and never pruned with it. The rules are the shared ones
 * (shared/session-organization-ownership.ts), so the window's mirror reaches the same answers.
 */

import type {
  OrganizationKeyState,
  OrganizationOwnershipField,
  OrganizationRecord,
  OrganizationRevocation
} from '../../shared/session-organization-change'
import {
  emptyOrganizationKeyState,
  isEmptyOrganizationKeyState,
  migrateOrganizationKeyState,
  organizationKeyStatesAfter,
  parseOrganizationKeyState,
  revokedOrganizationKeyState,
  seededOrganizationKeyState,
  withSyncStamp,
  type OwnershipSeed,
  type OwnershipSyncStamp
} from '../../shared/session-organization-ownership'

export class OrganizationKeyStates {
  private readonly states = new Map<string, OrganizationKeyState>()

  /** Reads the saved states field by field; a damaged entry is dropped (it then counts as yours). */
  load(raw: unknown): void {
    if (!raw || typeof raw !== 'object') {
      return
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const state = parseOrganizationKeyState(value)
      if (state) {
        this.states.set(key, state)
      }
    }
  }

  toJSON(): Record<string, OrganizationKeyState> {
    return Object.fromEntries(this.states)
  }

  stateFor(key: string): OrganizationKeyState {
    const state = this.states.get(key)
    return { ownership: { ...state?.ownership }, revocations: { ...state?.revocations } }
  }

  /** Every key's state (or only `keys`), as copies. */
  snapshot(keys?: readonly string[]): Record<string, OrganizationKeyState> {
    const wanted = keys ?? [...this.states.keys()]
    return Object.fromEntries(
      wanted.flatMap((key) => (this.states.has(key) ? [[key, this.stateFor(key)]] : []))
    )
  }

  /** The keys an applied record changed. */
  applyRecord(record: OrganizationRecord): string[] {
    const next = organizationKeyStatesAfter(record, (key) => this.current(key))
    for (const [key, state] of next) {
      this.put(key, state)
    }
    return [...next.keys()]
  }

  /** The keys whose owned change took its sync stamp. */
  attachSyncStamps(stamps: readonly OwnershipSyncStamp[]): string[] {
    return stamps
      .filter(({ key, ...stamp }) => this.update(key, (state) => withSyncStamp(state, stamp)))
      .map(({ key }) => key)
  }

  /** The keys seeded as launch-owned. */
  seed(seeds: readonly OwnershipSeed[], hasPlacementHistory: (key: string) => boolean): string[] {
    return seeds
      .filter((seed) =>
        this.update(seed.key, (state) =>
          seededOrganizationKeyState(state, seed, hasPlacementHistory(seed.key))
        )
      )
      .map(({ key }) => key)
  }

  /** The keys that took a revocation now (a field already revoked keeps its first one). */
  revoke(
    revocations: readonly {
      key: string
      field: OrganizationOwnershipField
      revocation: OrganizationRevocation
    }[]
  ): string[] {
    const changed = new Set<string>()
    for (const { key, field, revocation } of revocations) {
      if (this.update(key, (state) => revokedOrganizationKeyState(state, field, revocation))) {
        changed.add(key)
      }
    }
    return [...changed]
  }

  /** False when `from` held nothing to carry. */
  migrate(from: string, to: string, placementFrom: boolean): boolean {
    const carried = this.states.get(from)
    if (from === to || !carried) {
      return false
    }
    this.states.delete(from)
    this.put(to, migrateOrganizationKeyState(carried, this.current(to), placementFrom))
    return true
  }

  private current(key: string): OrganizationKeyState {
    return this.states.get(key) ?? emptyOrganizationKeyState()
  }

  /** True when `change` gave the key a new state. */
  private update(
    key: string,
    change: (state: OrganizationKeyState) => OrganizationKeyState
  ): boolean {
    const state = this.current(key)
    const next = change(state)
    if (next === state) {
      return false
    }
    this.put(key, next)
    return true
  }

  private put(key: string, state: OrganizationKeyState): void {
    if (isEmptyOrganizationKeyState(state)) {
      this.states.delete(key)
    } else {
      this.states.set(key, state)
    }
  }
}
