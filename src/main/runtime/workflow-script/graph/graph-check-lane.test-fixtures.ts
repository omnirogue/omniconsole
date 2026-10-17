import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitExecFileAsync } from '../../../git/command-runner/git-exec-file'
import { runGraphCheck } from './graph-check'
import { runGraphPatchCheck } from './graph-check-apply'
import { GraphCheckLanes } from './graph-check-lane'
import type { GraphCheckRequest } from './graph-plan-types'

export const NODE = `"${process.execPath}"`

// The person's test: passes when value is 2; leaves an untracked and an ignored file behind.
const TEST = [
  "import { mkdirSync, writeFileSync } from 'node:fs'",
  "import { value } from './src/value.mjs'",
  "writeFileSync('stray.txt', 'left by the test')",
  "mkdirSync('deps', { recursive: true })",
  "writeFileSync('deps/cache.txt', 'kept between versions')",
  'console.log(`SCORE: ${value}`)',
  'process.exit(value === 2 ? 0 : 1)'
].join('\n')

// Getting ready: counts each run in the ignored deps folder, or in a file named on its command line.
const PREPARE = [
  "import { appendFileSync, mkdirSync } from 'node:fs'",
  "mkdirSync('deps', { recursive: true })",
  "appendFileSync(process.argv[2] ?? 'deps/prepared.log', 'x')",
  'process.exit(process.argv[3] === "fail" ? 3 : 0)'
].join('\n')

export type LaneRepository = { parent: string; root: string; sourceBase: string; links: boolean }

async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitExecFileAsync(args, { cwd })).stdout.trim()
}

/** A person's repository in a temp folder: code, its test, a protected test file, a link. */
export async function laneRepository(): Promise<LaneRepository> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'graph-lane-')))
  const root = join(parent, 'repo')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'tests'), { recursive: true })
  await git(parent, ['init', '--quiet', root])
  await git(root, ['config', 'user.name', 'Lane test'])
  await git(root, ['config', 'user.email', 'lane@example.invalid'])
  await git(root, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(root, 'src', 'value.mjs'), 'export const value = 1\n')
  await writeFile(join(root, 'test.mjs'), `${TEST}\n`)
  await writeFile(join(root, 'prepare.mjs'), `${PREPARE}\n`)
  await writeFile(join(root, 'tests', 'spec.mjs'), 'export const spec = 1\n')
  await writeFile(join(root, '.gitignore'), 'deps/\n*.log\n')
  // Windows may refuse to make links without developer mode: those cases are skipped there.
  const links = await symlink('src', join(root, 'link'), 'dir').then(
    () => true,
    () => false
  )
  await git(root, ['add', '.'])
  await git(root, ['commit', '--quiet', '-m', 'start'])
  return { parent, root, sourceBase: await git(root, ['rev-parse', 'HEAD']), links }
}

export function laneLanes(repo: LaneRepository, root = repo.root): GraphCheckLanes {
  return new GraphCheckLanes({
    folder: join(repo.parent, 'run', 'lanes'),
    root: async () => root,
    sourceBase: repo.sourceBase
  })
}

/** A version's markdown with its change in a ```diff block. */
export const withDiff = (diff: string) => `My change.\n\n\`\`\`diff\n${diff}\`\`\`\n`

export const VALUE_TWO = [
  '--- a/src/value.mjs',
  '+++ b/src/value.mjs',
  '@@ -1 +1 @@',
  '-export const value = 1',
  '+export const value = 2',
  ''
].join('\n')

/** Runs one version the way a live run does: the check in a private copy of the code. */
export function lanePatchCheck(
  lanes: GraphCheckLanes,
  request: Partial<GraphCheckRequest> & { candidate: string }
) {
  const full: GraphCheckRequest = { command: `${NODE} test.mjs`, apply: 'patch', ...request }
  return runGraphPatchCheck(full, { lanes, test: (cwd) => runGraphCheck(full, { cwd }) })
}

/** Every byte of a folder, .git included, and every link's target: equal means untouched. */
export async function folderFingerprint(folder: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name)
      const info = await lstat(path)
      hash.update(`${path}\0${info.mode}\0`)
      if (info.isSymbolicLink()) {
        hash.update(await readlink(path))
      } else if (info.isDirectory()) {
        await walk(path)
      } else {
        hash.update(await readFile(path))
      }
    }
  }
  await walk(folder)
  return hash.digest('hex')
}
