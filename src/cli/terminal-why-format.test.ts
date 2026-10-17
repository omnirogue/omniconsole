import { describe, expect, it } from 'vitest'
import { formatTerminalWhy } from './terminal-why-format'
import type { RuntimeTerminalWhy } from '../shared/launch-ledger'
const uuid = '11111111-1111-4111-8111-111111111111'
const base: RuntimeTerminalWhy = {
  terminal: `term_${uuid}`,
  ptyId: uuid,
  paneKey: `${uuid}:${uuid}`,
  launch: {
    v: 1,
    ts: '2026-10-03T00:00:00.000Z',
    pipeline: 'runtime-controller',
    ptyId: uuid,
    cause: 'cli',
    hasStartupCommand: false,
    process: 'created'
  }
}
describe('launch outcome explanations', () => {
  it('explains an unfinished prepared start', () => {
    expect(
      formatTerminalWhy({ why: { ...base, launch: { ...base.launch!, process: 'prepared' } } })
    ).toBe(
      'This terminal was requested; outcome not recorded for cli, requested by an unspecified caller at 2026-10-03T00:00:00.000Z.'
    )
  })
  it('distinguishes transport identity from caller claims', () => {
    expect(
      formatTerminalWhy({
        why: {
          ...base,
          launch: {
            ...base.launch!,
            actor: {
              kind: 'paired-device',
              deviceId: uuid,
              unverifiedPaneKey: `${uuid}:${uuid}`,
              unverifiedTerminalHandle: `term_${uuid}`
            }
          }
        }
      })
    ).toBe(
      `This terminal started for cli, requested by paired-device ${uuid} at 2026-10-03T00:00:00.000Z; unverified caller claims ${uuid}:${uuid} term_${uuid}.`
    )
  })
})

describe('claimed owner attribution', () => {
  it('labels claimed reasons and owner references', () => {
    const launch = {
      ...base.launch!,
      claimedTrigger: 'automation',
      claimedReferenceHashes: { automationId: 'hash_0123456789ab' }
    }
    expect(formatTerminalWhy({ why: { ...base, launch } } as never)).toContain(
      `claimed cause automation; claimed automationId hash_0123456789ab`
    )
  })
})

describe('later attachments do not describe a second start', () => {
  it('explains the creation before later unfinished attachment requests', () => {
    const attachment = { ...base.launch!, process: 'attachment-intent', intent: 'attach' }
    expect(formatTerminalWhy({ why: { ...base, attachments: [attachment] } } as never)).toBe(
      'This terminal started for cli, requested by an unspecified caller at 2026-10-03T00:00:00.000Z. Later attachment requests: 1; latest attachment intent at 2026-10-03T00:00:00.000Z.'
    )
  })
})

it('explains an unrecorded current start and labels older incarnation creations as history', () => {
  expect(
    formatTerminalWhy({
      why: {
        ...base,
        launch: null,
        currentStartUnrecorded: true,
        previousCreations: [{ ...base.launch!, cause: 'automation' }]
      }
    } as never)
  ).toBe(
    'This process was started by a request whose outcome was not recorded. Previous process creation history: automation at 2026-10-03T00:00:00.000Z.'
  )
})
