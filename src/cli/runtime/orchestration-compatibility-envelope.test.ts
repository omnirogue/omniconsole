import { describe, expect, it } from 'vitest'
import { runtimeCompatibilityEnvelope } from './orchestration-compatibility-envelope'

const inherited = {
  compatibilityInvocationId: 'invocation-1',
  orchestrationCompatibilityEvidence: {
    terminalHandle: 'term_parent',
    paneKey: 'parent:leaf',
    launchToken: 'test-token'
  }
}

describe('generic launch caller evidence', () => {
  it('carries inherited caller claims without manufacturing orchestration authority', () => {
    expect(runtimeCompatibilityEnvelope('terminal.createAgentSession', inherited)).toEqual(
      inherited
    )
  })

  it('keeps ordinary launches unchanged when there is no source evidence', () => {
    expect(
      runtimeCompatibilityEnvelope('terminal.createAgentSession', {
        compatibilityInvocationId: 'invocation-1'
      })
    ).toEqual({})
  })

  it('preserves partial claims for host validation instead of treating them as a person', () => {
    const partial = { orchestrationCompatibilityEvidence: { paneKey: 'parent:leaf' } }
    expect(runtimeCompatibilityEnvelope('terminal.createAgentSession', partial)).toMatchObject(
      partial
    )
  })

  it('preserves explicit native and remote caller evidence', () => {
    const options = {
      compatibilityInvocationId: 'invocation-2',
      orchestrationCompatibilityEvidence: {
        agentSessionId: 'native-parent',
        launchToken: 'native-token'
      }
    }
    expect(runtimeCompatibilityEnvelope('terminal.createAgentSession', inherited, options)).toEqual(
      options
    )
    const remote = {
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_remote',
        host: {
          kind: 'ssh' as const,
          targetId: 'ssh-1',
          connectionIncarnation: 'connection-1',
          attachmentId: 'attachment-1'
        }
      }
    }
    expect(runtimeCompatibilityEnvelope('terminal.createAgentSession', remote)).toMatchObject(
      remote
    )
  })

  it('does not attach caller launch secrets to unrelated terminal reads', () => {
    expect(runtimeCompatibilityEnvelope('terminal.read', inherited)).toEqual({})
  })
})
