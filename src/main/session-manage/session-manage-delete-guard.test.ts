import { describe, expect, it } from 'vitest'
import {
  mirroredConversationDeleteRefusal,
  sessionDeleteRefusal
} from './session-manage-delete-guard'
import { manageEntry } from './session-manage-test-fixtures'

describe('sessionDeleteRefusal', () => {
  it('lets an idle session go when a report, the screen or the process table proves it', () => {
    for (const stateBasis of ['hook', 'last-report', 'screen', 'chat-host'] as const) {
      expect(sessionDeleteRefusal(manageEntry({ stateBasis }), { force: false })).toBeNull()
    }
    expect(
      sessionDeleteRefusal(manageEntry({ verdict: 'exited', state: 'exited' }), { force: false })
    ).toBe(null)
  })

  it('never deletes what this host cannot verify, --force or not', () => {
    for (const force of [false, true]) {
      expect(
        sessionDeleteRefusal(manageEntry({ state: 'unknown', stateBasis: 'none' }), { force })
      ).toContain('cannot be verified')
      expect(
        sessionDeleteRefusal(manageEntry({ verdict: 'unverifiable', state: 'unknown' }), { force })
      ).toContain('cannot be verified')
    }
  })

  it('needs --force for a working session, or one read from its title alone', () => {
    const working = manageEntry({ state: 'working', stateBasis: 'screen' })
    expect(sessionDeleteRefusal(working, { force: false })).toContain('still working')
    expect(sessionDeleteRefusal(working, { force: true })).toBeNull()
    const titleOnly = manageEntry({ state: 'idle', stateBasis: 'title' })
    expect(sessionDeleteRefusal(titleOnly, { force: false })).toContain(
      'only from its terminal title'
    )
    expect(sessionDeleteRefusal(titleOnly, { force: true })).toBeNull()
  })
})

describe('sessionDeleteRefusal: execution host', () => {
  it('never deletes a session an SSH host or another computer executes, --force or not', () => {
    for (const force of [false, true]) {
      expect(sessionDeleteRefusal(manageEntry({ hostId: 'ssh:build-box' }), { force })).toContain(
        'the SSH host build-box, not on this computer'
      )
      expect(sessionDeleteRefusal(manageEntry({ hostId: 'runtime:env-1' }), { force })).toContain(
        'another OmniConsole'
      )
    }
  })
})

describe('sessionDeleteRefusal: --unverified', () => {
  it('lets the person delete a session this computer runs but cannot verify', () => {
    for (const entry of [
      manageEntry({ state: 'unknown', stateBasis: 'none' }),
      manageEntry({ verdict: 'unverifiable', state: 'unknown' })
    ]) {
      expect(sessionDeleteRefusal(entry, { unverified: true })).toBeNull()
    }
  })

  it('never deletes what another computer or an SSH host runs: closing its tab would stop it there', () => {
    for (const hostId of ['ssh:build-box', 'runtime:env-1']) {
      const entry = manageEntry({ hostId, verdict: 'unverifiable', state: 'unknown' })
      expect(sessionDeleteRefusal(entry, { unverified: true, force: true })).toContain(
        'not on this computer'
      )
    }
    expect(
      sessionDeleteRefusal(manageEntry({ hostId: 'runtime:env-1' }), { unverified: true })
    ).toContain('delete it there')
  })

  it('still needs --force for a session this host proves is working', () => {
    const working = manageEntry({ state: 'working', stateBasis: 'screen' })
    expect(sessionDeleteRefusal(working, { unverified: true })).toContain('still working')
  })

  it('names --unverified when it refuses one it cannot verify', () => {
    expect(
      sessionDeleteRefusal(manageEntry({ verdict: 'unverifiable', state: 'unknown' }), {})
    ).toContain('--unverified')
  })
})

describe('mirroredConversationDeleteRefusal (session parity, step 7)', () => {
  it('names the paired owner as the place to delete it, whatever the flags', () => {
    const refusal = mirroredConversationDeleteRefusal('Owner live')
    expect(refusal).toContain('“Owner live” runs on another computer, which lists it')
    expect(refusal).toContain('--unverified included')
    expect(refusal).toContain('Delete it there')
  })
})
