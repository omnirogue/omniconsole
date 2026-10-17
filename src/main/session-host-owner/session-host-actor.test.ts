import { describe, expect, it } from 'vitest'
import {
  sessionHostPromptMarker,
  type SessionHostAuthority
} from '../../shared/session-host-authority'
import {
  sessionManageActorTitle,
  sessionManagePromptMarker
} from '../../shared/session-manage-types'
import { auditActor } from '../session-manage/session-actions-log'
import { unattendedContextFor } from '../session-manage/session-manage-unattended'
import { executorForActor } from '../session-organization/organization-relayed-mutation'
import { sessionHostActor } from './session-host-actor'

const person: SessionHostAuthority = {
  kind: 'remote',
  transport: 'paired-runtime',
  peer: 'device-7',
  origin: { computer: 'Laptop', requester: { kind: 'person', via: 'sidebar' } }
}
const pane: SessionHostAuthority = {
  kind: 'remote',
  transport: 'ssh-relay',
  peer: 'host_0a',
  origin: {
    computer: 'Studio',
    requester: { kind: 'pane', paneKey: 'tab-1:leaf-1', title: 'Release notes' }
  }
}
const steward: SessionHostAuthority = {
  kind: 'remote',
  transport: 'paired-runtime',
  peer: 'device-7',
  origin: { computer: 'Studio', requester: { kind: 'cli', unattended: { source: 'rules' } } }
}

describe('the actor another computer acts as here', () => {
  it.each([person, pane, steward])(
    'says who and which computer in the same marker admission stamps (%#)',
    (authority) => {
      const actor = sessionHostActor(authority)
      expect(sessionManagePromptMarker(sessionManageActorTitle(actor))).toBe(
        sessionHostPromptMarker(authority)
      )
    }
  )

  it('keeps an unattended origin unattended, so this host’s own steward rules apply to it', () => {
    expect(unattendedContextFor(sessionHostActor(steward))).toEqual({ source: 'rules' })
    expect(unattendedContextFor(sessionHostActor(person))).toBeNull()
    expect(sessionManageActorTitle(sessionHostActor(steward))).toBe('Session steward on Studio')
  })

  it('is audited as remote, with the computer and requester, and never as a local pane', () => {
    expect(auditActor(sessionHostActor(pane))).toEqual({
      actor: 'remote',
      remote: {
        computer: 'Studio',
        peer: 'host_0a',
        requester: 'pane',
        title: 'Release notes on Studio'
      }
    })
  })

  it('commits organization as the person, an agent, or the steward, never as a pane here', () => {
    expect(executorForActor(sessionHostActor(person))).toEqual({ kind: 'person', via: 'sidebar' })
    expect(executorForActor(sessionHostActor(pane))).toEqual({ kind: 'cli' })
    expect(executorForActor(sessionHostActor(steward))).toEqual({ kind: 'app', feature: 'steward' })
  })

  it('passes this host’s own callers through unchanged', () => {
    const local: SessionHostAuthority = { kind: 'local', actor: { kind: 'cli' } }
    expect(sessionHostActor(local)).toEqual({ kind: 'cli' })
    expect(sessionHostActor({ kind: 'steward', feature: 'cleanup-run', runId: 'r1' })).toEqual({
      kind: 'steward',
      feature: 'cleanup-run',
      runId: 'r1'
    })
  })
})
