import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// A NUL byte anywhere near the top of a source file makes git call the file binary: its diff
// then reads "Binary files differ" and the code never reaches a reviewer. This check asks git
// for its own text/binary verdict and fails when a new source file is not text. The baseline
// grandfathers files that were already binary; it may only shrink.

const BASELINE_PATH = 'config/text-sources-baseline.txt'
const SOURCE_PATHSPECS = [
  '*.ts',
  '*.tsx',
  '*.js',
  '*.jsx',
  '*.mjs',
  '*.cjs',
  '*.json',
  '*.jsonc',
  '*.css',
  '*.html',
  '*.md',
  '*.yml',
  '*.yaml'
]

export function parseBaseline(contents) {
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/** Paths `git ls-files --eol` reported as non-text, in either the index or the working tree. */
export function binaryPathsFromEol(output) {
  const paths = []
  for (const line of output.split('\n')) {
    if (!line.trim()) {
      continue
    }
    const tab = line.indexOf('\t')
    if (tab === -1) {
      continue
    }
    const attributes = line.slice(0, tab).split(/\s+/)
    const file = line.slice(tab + 1)
    if (attributes.some((attribute) => attribute === 'i/-text' || attribute === 'w/-text')) {
      paths.push(file)
    }
  }
  return paths.sort()
}

export function diffBaseline(found, baseline) {
  const known = new Set(baseline)
  const seen = new Set(found)
  return {
    added: found.filter((file) => !known.has(file)),
    fixed: baseline.filter((file) => !seen.has(file))
  }
}

export function main(root = process.cwd()) {
  const baselineFile = path.join(root, BASELINE_PATH)
  const baseline = fs.existsSync(baselineFile)
    ? parseBaseline(fs.readFileSync(baselineFile, 'utf8'))
    : []
  const output = execFileSync('git', ['ls-files', '--eol', '--', ...SOURCE_PATHSPECS], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  const { added, fixed } = diffBaseline(binaryPathsFromEol(output), baseline)
  if (added.length > 0) {
    const list = added.map((file) => `  ${file}`).join('\n')
    console.error(
      `These source files are binary to git, so their diffs are hidden from review:\n${list}\nRemove the NUL bytes (search for \\u0000 in string literals) and run this check again.`
    )
  }
  if (fixed.length > 0) {
    const list = fixed.map((file) => `  ${file}`).join('\n')
    console.error(`These files are text again — delete them from ${BASELINE_PATH}:\n${list}`)
  }
  return added.length > 0 || fixed.length > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
