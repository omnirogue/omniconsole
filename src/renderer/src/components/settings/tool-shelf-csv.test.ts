import { describe, expect, it } from 'vitest'
import type {
  AccessSectionSummary,
  PrincipalSummary
} from '../../../../shared/console-access-contract'
import {
  parseShelfCsv,
  serialiseShelfCsv,
  shelfCsvChanges,
  SHELF_CSV_HEADER
} from './tool-shelf-csv'

const sections: AccessSectionSummary[] = [
  {
    key: 'finance',
    label: 'Finance',
    groups: ['payments'],
    read_ref: '@section:finance:read',
    write_ref: '@section:finance:write',
    read_count: 12,
    write_count: 7,
    floor_count: 3
  },
  {
    key: 'advertising',
    label: 'Advertising',
    groups: ['ads'],
    read_ref: '@section:advertising:read',
    write_ref: '@section:advertising:write',
    read_count: 4,
    write_count: 4,
    floor_count: 0
  }
]

const principals = [
  {
    principal: 'human:emp_shona',
    kind: 'human',
    overrides: [],
    sections: {
      finance: { read: { granted: 12, total: 12 }, write: { granted: 3, total: 7 } },
      advertising: { read: { granted: 0, total: 4 }, write: { granted: 0, total: 4 } }
    }
  }
] as unknown as PrincipalSummary[]

describe('the Tool Shelf grid as a file', () => {
  it('writes one line per person and section, on only when the whole ref is held', () => {
    expect(serialiseShelfCsv(principals, sections)).toBe(
      [
        SHELF_CSV_HEADER,
        'human:emp_shona,finance,on,off',
        'human:emp_shona,advertising,off,off',
        ''
      ].join('\n')
    )
  })

  it('reads a file back, ignoring blank lines and carriage returns', () => {
    const parsed = parseShelfCsv(
      `${SHELF_CSV_HEADER}\r\nhuman:emp_shona,finance,on,off\r\n\r\nagent:luna-scout,advertising,yes,1\r\n`
    )
    expect(parsed.problems).toEqual([])
    expect(parsed.rows).toEqual([
      { principal: 'human:emp_shona', section: 'finance', read: true, write: false },
      { principal: 'agent:luna-scout', section: 'advertising', read: true, write: true }
    ])
  })

  it('names the line and the reason for every row it will not read', () => {
    const parsed = parseShelfCsv(
      [
        'person,section,read,write',
        'human:emp_shona,finance,on,off',
        '../policy/grant,finance,on,off',
        'human:emp_sal,Finance!,on,off',
        'human:emp_sal,finance,maybe,off',
        'human:emp_sal,finance'
      ].join('\n')
    )
    expect(parsed.rows).toEqual([
      { principal: 'human:emp_shona', section: 'finance', read: true, write: false }
    ])
    expect(parsed.problems.map((problem) => [problem.line, problem.code])).toEqual([
      [1, 'header'],
      [3, 'principal'],
      [4, 'section'],
      [5, 'value'],
      [6, 'columns']
    ])
  })

  it('turns each row into two section-ref changes, never a capability id', () => {
    expect(
      shelfCsvChanges([
        { principal: 'human:emp_shona', section: 'finance', read: true, write: false }
      ])
    ).toEqual([
      {
        principal: 'human:emp_shona',
        action: 'grant',
        target: '@section:finance:read'
      },
      {
        principal: 'human:emp_shona',
        action: 'deny',
        target: '@section:finance:write'
      }
    ])
  })
})
