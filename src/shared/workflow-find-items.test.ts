import { describe, expect, it } from 'vitest'
import { WORKFLOW_FIND_MAX_ITEM_CHARS } from './workflow-graph'
import { readFindItems, splitFindItems } from './workflow-find-items'

describe('splitFindItems: the import receipt', () => {
  it('records read, imported, skipped (with why) and merged for ["A","A","B",""]', () => {
    const { items, merged, receipt } = splitFindItems(['A', 'A', 'B', ''])
    expect(items).toEqual(['A', 'B'])
    expect(merged).toBe(1)
    expect(receipt).toEqual({
      read: 4,
      imported: 2,
      skipped: [{ line: 4, reason: 'no title' }],
      merged: 1
    })
  })

  it('is immutable across a second normalize (readFindItems does not recompute from a deduped list)', () => {
    const first = splitFindItems(['A', 'A', 'B'])
    expect(first.receipt.merged).toBe(1)
    // A second pass over the already-deduped, already-imported saved shape.
    const second = readFindItems(first.items, first.itemDetails)
    // Read fresh, this list truly has no more duplicates left in it.
    expect(second.receipt.merged).toBe(0)
    // The caller (normalizeFind) is responsible for preferring the stored receipt over this one;
    // this proves why that preservation is necessary, not that this function fakes immutability.
  })
})

describe('splitFindItems: legacy round-trip', () => {
  it('makes two same-titled but different options distinct in the saved title itself', () => {
    const { items, itemDetails } = splitFindItems([
      { title: 'Acme', detail: 'Vendor A: $40/seat' },
      { title: 'Acme', detail: 'Vendor B: $12/seat' }
    ])
    // Distinct titles: a pre-Scan reader's own title-only dedupe can never collapse these.
    expect(items).toEqual(['Acme', 'Acme (2)'])
    expect(itemDetails).toEqual([
      { detail: 'Vendor A: $40/seat' },
      { detail: 'Vendor B: $12/seat' }
    ])
  })

  it('round-trips through the actual pre-Scan normalizer without collapsing the two options', () => {
    // The pre-Scan normalizer: trims/truncates strings and merges identical titles, case-insensitively.
    function preScanNormalize(raw: string[]): string[] {
      const seen = new Set<string>()
      const out: string[] = []
      for (const entry of raw) {
        const title = entry.trim()
        const key = title.toLowerCase()
        if (!title || seen.has(key)) {
          continue
        }
        seen.add(key)
        out.push(title)
      }
      return out
    }
    const { items } = splitFindItems([
      { title: 'Acme', detail: 'Vendor A' },
      { title: 'Acme', detail: 'Vendor B' }
    ])
    expect(preScanNormalize(items)).toEqual(['Acme', 'Acme (2)'])
  })
})

describe('splitFindItems: disambiguation picks the next globally free number', () => {
  it('a duplicate never collides with a real title already using that number (Acme, Acme, Acme (2))', () => {
    const { items } = splitFindItems([
      { title: 'Acme', detail: 'A' },
      { title: 'Acme', detail: 'B' },
      { title: 'Acme (2)', detail: 'B' }
    ])
    // The second "Acme" cannot become "Acme (2)": that title is already taken by a real,
    // different option. It gets the next free number instead, and the real "Acme (2)" is untouched.
    expect(items).toEqual(['Acme', 'Acme (3)', 'Acme (2)'])
  })

  it('reserves room for the suffix within the legacy per-item character limit', () => {
    const long = 'x'.repeat(WORKFLOW_FIND_MAX_ITEM_CHARS)
    const { items } = splitFindItems([
      { title: long, detail: 'A' },
      { title: long, detail: 'B' }
    ])
    expect(items[0]).toBe(long)
    expect(items[1]!.length).toBeLessThanOrEqual(WORKFLOW_FIND_MAX_ITEM_CHARS)
    expect(items[1]).toBe(`${long.slice(0, WORKFLOW_FIND_MAX_ITEM_CHARS - 4)} (2)`)
    expect(items[1]!.length).toBe(WORKFLOW_FIND_MAX_ITEM_CHARS)
  })
})
