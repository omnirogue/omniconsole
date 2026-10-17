import { describe, expect, it, vi } from 'vitest'
import type { SessionHostsStatusResult } from '../../../../shared/session-hosts-status'
import { otherComputerLines } from './other-computers-model'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

const HOST_ID = 'host_c3ad3c23b1ff43a4b4687a6e9dbb6261'

function status(extra: Partial<SessionHostsStatusResult> = {}): SessionHostsStatusResult {
  return {
    hosts: [
      {
        hostKey: 'runtime:studio',
        kind: 'runtime',
        state: 'ready',
        hostId: HOST_ID,
        capabilities: ['session-control.owner.v1'],
        checkedAt: 1,
        counts: {
          total: 100,
          live: 95,
          exited: 3,
          unverifiable: 2,
          working: 40,
          needsYou: 4,
          stalled: 1
        }
      },
      {
        hostKey: 'ssh:build',
        kind: 'ssh',
        state: 'unreachable',
        capabilities: [],
        checkedAt: 1,
        counts: null
      },
      {
        hostKey: 'runtime:old',
        kind: 'runtime',
        state: 'older',
        detail: 'runtime 1.4',
        capabilities: [],
        checkedAt: 1,
        counts: null
      }
    ],
    refreshing: false,
    switches: [],
    folderPolicies: {},
    thisHostOffElsewhere: false,
    ...extra
  }
}

describe('the Work card’s other computers', () => {
  it('folds a hundred sessions on one computer into one line, and explains the others', () => {
    const lines = otherComputerLines(status(), new Map([['runtime:studio', 'Studio']]))
    expect(lines.map((line) => [line.label, line.summary])).toEqual([
      ['Studio', '100 sessions · 40 working · 4 need you · 1 stalled · 2 can’t be verified'],
      ['ssh:build', 'Can’t be reached; its sessions are left alone'],
      ['runtime:old', 'Older OmniConsole; controls are unavailable until it updates']
    ])
    expect(lines[2]!.detail).toBe('runtime 1.4')
  })

  it('shows a host switch as pending until that computer confirms it', () => {
    const reading = { hostId: HOST_ID, automation: 'off' as const, at: 5, setHere: true }
    const pending = otherComputerLines(
      status({ switches: [{ ...reading, state: 'pending' }] }),
      new Map()
    )
    expect(pending[0]!.automationOff).toBe('pending')
    const applied = otherComputerLines(
      status({ switches: [{ ...reading, state: 'applied' }] }),
      new Map()
    )
    expect(applied[0]!.automationOff).toBe('applied')
    expect(applied[1]!.automationOff).toBeUndefined()
  })
})
