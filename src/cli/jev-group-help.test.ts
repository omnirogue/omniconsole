import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from './index'

let log: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  process.exitCode = undefined
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

const printed = () => log.mock.calls.map(([text]) => String(text)).join('\n')

describe('JEV group help', () => {
  it.each([[['jev', '--help']], [['help', 'jev']]])('prints the jev group for %j', async (argv) => {
    await main(argv, '/tmp/repo')

    expect(printed()).not.toContain('Unknown command')
    expect(printed()).toContain('Usage: omni jev <command> [options]')
    for (const command of ['status', 'on', 'off', 'request', 'rubrics list', 'rubrics evaluate']) {
      expect(printed()).toMatch(new RegExp(`\\n  ${command} +\\S`))
    }
    expect(process.exitCode).toBeUndefined()
  })

  it('prints only the rubric commands for jev rubrics', async () => {
    await main(['jev', 'rubrics', '--help'], '/tmp/repo')

    expect(printed()).toContain('Usage: omni jev rubrics <command> [options]')
    expect(printed()).toContain('\n  list ')
    expect(printed()).toContain('\n  save ')
    expect(printed()).toContain('\n  evaluate ')
    expect(printed()).not.toContain('\n  status ')
    expect(printed()).toContain('Run `omni jev rubrics <command> --help`')
    expect(process.exitCode).toBeUndefined()
  })

  it('prints the records group and lists outcome under jev', async () => {
    await main(['jev', 'records', '--help'], '/tmp/repo')
    expect(printed()).toContain('Usage: omni jev records <command> [options]')
    expect(printed()).toContain('\n  list ')
    expect(printed()).toContain('\n  export ')
    log.mockClear()
    await main(['jev', '--help'], '/tmp/repo')
    expect(printed()).toMatch(/\n  outcome +Append an independent outcome label/)
    expect(process.exitCode).toBeUndefined()
  })

  it('names all six request recipes and no browser page flag in request help', async () => {
    await main(['jev', 'request', '--help'], '/tmp/repo')

    for (const recipe of [
      'work_routing',
      'evidence_review',
      'advertising_review',
      'support_triage',
      'retrieval_review',
      'lead_fit'
    ]) {
      expect(printed()).toContain(recipe)
    }
    expect(printed()).toContain('jev-request:<request_id>')
    expect(printed()).not.toContain('--page')
  })
})
