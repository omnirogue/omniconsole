/**
 * The names a handoff package travels under. A package is flat: the relay and the hub both store a
 * file by its last path segment and refuse a repeat, so two runs' `manifest.md` cannot both keep
 * that name. A run's own output (under `.omni/runs/<run>/`) is renamed after its step, the same
 * way every time; the person's files and the generated summary and transcript never are.
 */
export type PackageEntry = {
  /** Where the bytes were read from; null for a file this app generated. */
  sourcePath: string | null
  /** The name the bytes were captured under (a folder already carries its archive suffix). */
  name: string
}

const NAME_MAX = 255
const UUID_TAIL = /([_-][0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RUN_ID_CHARS = 15

/** `<run>` and the path below it for a file under `.omni/runs/<run>/`; null for any other file. */
function runOutput(sourcePath: string | null): { run: string; below: string[] } | null {
  const parts = (sourcePath ?? '').split(/[\\/]+/).filter(Boolean)
  const at = parts.findIndex((part, index) => part === '.omni' && parts[index + 1] === 'runs')
  const below = at === -1 ? [] : parts.slice(at + 3)
  return below.length > 0 ? { run: parts[at + 2]!, below } : null
}

function qualified(qualifiers: string[], name: string): string {
  const prefix = qualifiers
    // Why: a step folder is named `<step>_<uuid>`; eight characters of it already tell runs apart.
    .map((part) => part.replace(UUID_TAIL, '$1').replace(/^\.+/, ''))
    .filter(Boolean)
    .join('-')
    .slice(0, Math.max(0, NAME_MAX - name.length - 1))
  return prefix ? `${prefix}-${name}` : name
}

/** Tier 0 keeps the captured name, 1 adds the step and folders inside the run, 2 adds the run. */
function nameAt(entry: PackageEntry, tier: number): string {
  const output = runOutput(entry.sourcePath)
  if (!output || tier === 0) {
    return entry.name
  }
  const folders = output.below.slice(0, -1)
  return qualified(
    tier === 1 ? folders : [output.run.slice(0, RUN_ID_CHARS), ...folders],
    entry.name
  )
}

function numbered(name: string, count: number): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const suffix = `-${count}`
  return `${stem.slice(0, NAME_MAX - suffix.length - (name.length - stem.length))}${suffix}${name.slice(stem.length)}`
}

// Why: the recipient's disk may be case-insensitive, so `Manifest.md` and `manifest.md` collide too.
const key = (name: string): string => name.normalize('NFC').toLowerCase()

function collisions(names: readonly string[]): Map<string, number[]> {
  const groups = new Map<string, number[]>()
  names.forEach((name, index) => groups.set(key(name), [...(groups.get(key(name)) ?? []), index]))
  return new Map([...groups].filter(([, members]) => members.length > 1))
}

/**
 * One distinct name per entry, in order. `duplicate` names the first collision that renaming a
 * run's output cannot settle: two of the person's own files, or one of them and a generated file.
 */
export function packageFileNames(
  entries: readonly PackageEntry[]
): { names: string[] } | { duplicate: string } {
  const renamable = entries.map((entry) => runOutput(entry.sourcePath) !== null)
  const tiers = entries.map(() => 0)
  let names = entries.map((entry) => entry.name)
  for (let pass = 0; pass < 2; pass += 1) {
    for (const members of collisions(names).values()) {
      for (const index of members) {
        if (renamable[index]) {
          tiers[index] = Math.max(tiers[index]!, pass + 1)
        }
      }
    }
    names = entries.map((entry, index) => nameAt(entry, tiers[index]!))
  }
  for (const members of collisions(names).values()) {
    // Why: sorted by source so the same package is numbered the same way on every capture.
    const ordered = members
      .filter((index) => renamable[index])
      .sort((a, b) => entries[a]!.sourcePath!.localeCompare(entries[b]!.sourcePath!, 'en'))
    ordered.slice(members.length === ordered.length ? 1 : 0).forEach((index, position) => {
      names[index] = numbered(names[index]!, position + 2)
    })
  }
  const unsettled = [...collisions(names).values()][0]
  return unsettled ? { duplicate: entries[unsettled[0]!]!.name } : { names }
}
