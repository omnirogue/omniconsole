import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../../shared/child-process/run-process'
import type { WorkflowPlacementDispatch } from '../../../shared/local-workflow-placement'
import { workflowContextSkippedName } from './context/context-exclusions'
import {
  workflowFleetFailure,
  workflowFleetShellQuote,
  workflowFleetSsh,
  type WorkflowFleetRun
} from './workflow-fleet-remote-shell'

/** What one run may copy to a host: smaller than a context folder, since it crosses the network. */
export const WORKFLOW_FLEET_COPY_MAX_BYTES = 512 * 1024 ** 2
export const WORKFLOW_FLEET_COPY_MAX_FILES = 100_000
const COPY_TIMEOUT_MS = 10 * 60_000

/** Every file agents may read under `root`, as the context copy would take it; no links. */
async function listCopyFiles(root: string): Promise<{ files: string[]; bytes: number }> {
  const files: string[] = []
  let bytes = 0
  const queue = ['']
  while (queue.length) {
    const folder = queue.pop()!
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      if (workflowContextSkippedName(entry.name)) {
        continue
      }
      const path = folder ? `${folder}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        queue.push(path)
      } else if (entry.isFile()) {
        bytes += (await lstat(join(root, path))).size
        files.push(path)
        if (bytes > WORKFLOW_FLEET_COPY_MAX_BYTES || files.length > WORKFLOW_FLEET_COPY_MAX_FILES) {
          throw new Error(
            `What the agents read is larger than ${WORKFLOW_FLEET_COPY_MAX_BYTES / 1024 ** 2} MB or ${WORKFLOW_FLEET_COPY_MAX_FILES.toLocaleString('en-US')} files without node_modules and .git, too much to copy to another computer. Choose files or folders, or 'this computer'.`
          )
        }
      }
    }
  }
  return { files: files.sort(), bytes }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/**
 * Copies what the agents may read (the frozen workspace root, or the run's context folder) to
 * `<run>/workspace` on the host: an archive built here, copied with scp over the same SSH, checked
 * against its digest there and unpacked. Credential names, node_modules, .git and links stay here.
 */
export async function copyWorkflowFleetWorkspace(
  input: { host: string; alias: string; root: string; target: string },
  deps: { run?: WorkflowFleetRun; tmp?: string }
): Promise<NonNullable<WorkflowPlacementDispatch['workspace']>> {
  const { files, bytes } = await listCopyFiles(input.root)
  const staging = await mkdtemp(join(deps.tmp ?? tmpdir(), 'omni-fleet-'))
  try {
    const list = join(staging, 'files')
    const archive = join(staging, 'workspace.tar.gz')
    await writeFile(list, files.map((file) => `${file}\0`).join(''), { mode: 0o600 })
    const run = deps.run ?? runProcess
    const packed = await run({
      program: 'tar',
      args: ['-czf', archive, '-C', input.root, '--null', '-T', list],
      timeoutMs: COPY_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
    if (packed.code !== 0) {
      throw new Error(`The workspace could not be packed for ${input.host}.`)
    }
    const digest = await sha256File(archive)
    const copied = await run({
      program: 'scp',
      args: [
        '-q',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=3',
        archive,
        `${input.alias}:${input.target}.tar.gz`
      ],
      timeoutMs: COPY_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    }).catch(() => undefined)
    if (!copied || copied.code !== 0) {
      throw new Error(workflowFleetFailure(input.host, 'receive the workspace copy', copied))
    }
    const target = workflowFleetShellQuote(input.target)
    const unpacked = await workflowFleetSsh(
      deps,
      input.alias,
      [
        'set -e',
        `sum=$( (shasum -a 256 ${target}.tar.gz 2>/dev/null || sha256sum ${target}.tar.gz) | cut -d ' ' -f 1)`,
        `[ "$sum" = ${workflowFleetShellQuote(digest)} ] || { echo "digest mismatch" >&2; exit 3; }`,
        `mkdir -m 700 ${target}`,
        `tar -xzf ${target}.tar.gz -C ${target}`,
        `rm -f ${target}.tar.gz`,
        'printf unpacked'
      ].join('\n'),
      COPY_TIMEOUT_MS
    )
    if (!unpacked || unpacked.code !== 0 || unpacked.stdout.trim() !== 'unpacked') {
      throw new Error(workflowFleetFailure(input.host, 'unpack the workspace copy', unpacked))
    }
    return { path: input.target, files: files.length, bytes, digest }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
