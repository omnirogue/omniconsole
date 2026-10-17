import { describe, expect, it } from 'vitest'
import { parseFindScan, scanFormat, WORKFLOW_FIND_SCAN_MAX_BYTES } from './workflow-find-scan'
import { WORKFLOW_FIND_MAX_ITEMS } from './workflow-graph'

describe('Scan file import', () => {
  it('detects common CSV headers, BOM, quotes, escaped quotes and multiline descriptions', () => {
    expect(
      parseFindScan(
        '\uFEFFName,Description,Link\r\nAlpha,"a, b\n""quoted""",https://example.com\r\n'
      )
    ).toMatchObject({
      items: [{ title: 'Alpha', detail: 'a, b\n"quoted"', url: 'https://example.com' }],
      skipped: 0
    })
  })
  it('recovers later rows after an unmatched quote', () => {
    expect(parseFindScan('title,detail\n"broken,description\nGood,yes\nLast,ok')).toMatchObject({
      items: [
        { title: 'Good', detail: 'yes' },
        { title: 'Last', detail: 'ok' }
      ],
      skipped: 1
    })
  })
  it('uses explicit CSV column names', () => {
    expect(
      parseFindScan('Repo,About,Site\na/b,Fast,https://github.com/a/b', 'csv', {
        title: 'Repo',
        detail: 'About',
        url: 'Site'
      }).items
    ).toEqual([{ title: 'a/b', detail: 'Fast', url: 'https://github.com/a/b' }])
  })
  it('skips blank titles, empty rows, wrong column counts and malformed quotes', () => {
    expect(
      parseFindScan(
        'title,detail\nGood,yes\n,missing\n\nwrong,too,many\n"closed"oops,no\nLast,ok\n"unfinished'
      )
    ).toMatchObject({
      items: [
        { title: 'Good', detail: 'yes' },
        { title: 'Last', detail: 'ok' }
      ],
      skipped: 5
    })
  })
  it('maps JSON objects and skips rows without string titles', () => {
    expect(
      parseFindScan(
        JSON.stringify([
          { repo: 'a/b', about: 'Good', site: 'https://github.com/a/b' },
          {},
          null,
          { repo: 3 }
        ]),
        'json',
        { title: 'repo', detail: 'about', url: 'site' }
      )
    ).toMatchObject({
      items: [{ title: 'a/b', detail: 'Good', url: 'https://github.com/a/b' }],
      skipped: 3
    })
  })
  it('accepts JSON strings and auto-detects object fields', () => {
    expect(parseFindScan('[" A ", "", "B"]')).toMatchObject({ items: ['A', 'B'], skipped: 1 })
    expect(parseFindScan('[{"name":"A","description":"B","link":"C"}]').items).toEqual([
      { title: 'A', detail: 'B', url: 'C' }
    ])
  })
  it('names invalid JSON, empty files, missing fields and duplicate headers', () => {
    expect(() => parseFindScan('[oops]')).toThrow('not valid JSON')
    expect(() => parseFindScan('{}')).toThrow('array')
    for (const raw of ['', ' ', '[]', 'title\n']) {
      expect(() => parseFindScan(raw)).toThrow(/empty|no option rows/)
    }
    expect(() => parseFindScan('what\na')).toThrow('title field')
    expect(() => parseFindScan('title,title\na,b')).toThrow('header')
    expect(() => parseFindScan('title\na', 'csv', { title: 'missing' })).toThrow('not found')
  })
  it('rejects oversized bytes and rows in both formats, counting invalid rows too', () => {
    for (const format of ['csv', 'json'] as const) {
      expect(() => parseFindScan('a'.repeat(WORKFLOW_FIND_SCAN_MAX_BYTES + 1), format)).toThrow(
        '1 MB'
      )
    }
    expect(() =>
      parseFindScan(
        JSON.stringify(Array.from({ length: WORKFLOW_FIND_MAX_ITEMS + 1 }, (_, n) => `a${n}`))
      )
    ).toThrow(`at most ${WORKFLOW_FIND_MAX_ITEMS}`)
    expect(() => parseFindScan(`title\n${'a\n'.repeat(WORKFLOW_FIND_MAX_ITEMS + 1)}`)).toThrow(
      `at most ${WORKFLOW_FIND_MAX_ITEMS}`
    )
    expect(
      parseFindScan(JSON.stringify(Array(WORKFLOW_FIND_MAX_ITEMS).fill('a'))).items
    ).toHaveLength(WORKFLOW_FIND_MAX_ITEMS)
  })
  it('infers format by extension then content', () => {
    expect(scanFormat('list.JSON', 'broken')).toBe('json')
    expect(scanFormat('list.csv', '[x]')).toBe('csv')
    expect(scanFormat('list', '\uFEFF ["a"]')).toBe('json')
  })
})
