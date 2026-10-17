import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readConsoleActivationIntent,
  retainConsoleActivationIntent
} from './console-workflow-activation-intent'

vi.mock('../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/unused'
}))
vi.mock('./console-workflow-person', () => ({
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'console-activation-intent-'))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
describe('activation request transport persistence', () => {
  const principal = 'a'.repeat(64)
  const digest = 'b'.repeat(64)
  it('retains only stable request IDs across reopen and keeps people and digests isolated', () => {
    expect(readConsoleActivationIntent(principal, 'job_local12345', digest, directory)).toBeNull()
    const first = retainConsoleActivationIntent(principal, 'job_local12345', digest, directory)
    expect(readConsoleActivationIntent(principal, 'job_local12345', digest, directory)).toEqual(
      first
    )
    expect(retainConsoleActivationIntent(principal, 'job_local12345', digest, directory)).toEqual(
      first
    )
    expect(
      retainConsoleActivationIntent('c'.repeat(64), 'job_local12345', digest, directory)
    ).not.toEqual(first)
    expect(
      retainConsoleActivationIntent(principal, 'job_local12345', 'd'.repeat(64), directory)
    ).not.toEqual(first)
    for (const file of readdirSync(join(directory, 'console-activation-transport'))) {
      const stored = JSON.parse(
        readFileSync(join(directory, 'console-activation-transport', file), 'utf8')
      )
      expect(Object.keys(stored).sort()).toEqual(['claimRequestId', 'runnerInstance', 'version'])
    }
  })
  it('fails closed on a corrupt retained request instead of replacing it', () => {
    retainConsoleActivationIntent(principal, 'job_local12345', digest, directory)
    const file = readdirSync(join(directory, 'console-activation-transport'))[0]
    writeFileSync(join(directory, 'console-activation-transport', file), '{broken')
    expect(() =>
      retainConsoleActivationIntent(principal, 'job_local12345', digest, directory)
    ).toThrow('no new claim')
  })
})
