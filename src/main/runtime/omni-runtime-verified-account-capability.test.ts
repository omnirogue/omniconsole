import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../shared/protocol-version'
import { OrcaRuntimeService } from './omni-runtime'

function runtime() {
  return new OrcaRuntimeService({ getSettings: () => ({}) } as never)
}

function accountServices(accountCapacity: object | null) {
  return {
    claudeAccounts: {},
    codexAccounts: {},
    rateLimits: { accountCapacity }
  } as never
}

describe('verified-account launch capability', () => {
  it('advertises agent-session.verified-account-launch.v1 only with account capacity services', () => {
    // Why not static: orcad has no account services, so it must never claim it can verify.
    expect(RUNTIME_CAPABILITIES).not.toContain(
      AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY
    )
    const orcad = runtime()
    expect(orcad.getStatus().capabilities).not.toContain(
      AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY
    )
    const withoutCapacity = runtime()
    withoutCapacity.setAccountServices(accountServices(null))
    expect(withoutCapacity.getStatus().capabilities).not.toContain(
      AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY
    )
    const desktop = runtime()
    desktop.setAccountServices(accountServices({ snapshot: () => ({}) }))
    expect(desktop.getStatus().capabilities).toContain(
      AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY
    )
  })
})
