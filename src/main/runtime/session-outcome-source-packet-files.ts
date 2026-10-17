import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { captureFollowUpFiles } from '../../shared/session-follow-up-capture'
import { parseDeliverablesManifest } from '../../shared/session-follow-up-deliverables'
import { readExactHandoffFile } from '../../shared/exact-handoff-file-read'
import { sessionChainStepOutputDir } from '../../shared/session-chain-types'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeSourcePacket } from '../../shared/session-outcome-source-packet'
import { materializeOne } from './session-handoff-destination'
import { isImplicitFleetSecret } from './conversation-fleet-source-git'

const MAX_BYTES = 10 * 1024 * 1024

async function packetDirectory(chain: SessionChain, sourceVersion: string): Promise<string> {
  const root = await realpath(chain.workspacePath)
  const path = sessionChainStepOutputDir(root, chain.id, `source-${sourceVersion}`)
  const rel = relative(root, path)
  if (!rel || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error('The source packet must remain inside its execution workspace.')
  }
  let current = root
  for (const part of rel.split(sep)) {
    current = join(current, part)
    await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error
      }
    })
    if (!(await lstat(current)).isDirectory() || (await realpath(current)) !== current) {
      throw new Error('The source packet directory changed or contains a symbolic link.')
    }
  }
  return current
}

/** Source outputs come from its report and workspace changes, before any successor runs. */
export async function captureSourcePacketFiles(
  chain: SessionChain,
  sourceWorkspace: string,
  sourceVersion: string,
  summary: string,
  changedPaths: string[] = []
): Promise<Pick<SessionOutcomeSourcePacket, 'files' | 'missingFiles'>> {
  const root = await realpath(sourceWorkspace)
  const selected = parseDeliverablesManifest(
    summary,
    `${sourceWorkspace}${sourceWorkspace.endsWith(sep) ? '' : sep}`,
    sourceWorkspace
  )
  const paths = [...new Set([...selected.paths, ...changedPaths])]
  if (paths.length + selected.refused.length > 32) {
    throw new Error(
      `The source has ${paths.length + selected.refused.length} output references; a source packet supports 32 files. Reduce the source output scope before saving Next again.`
    )
  }
  const files: SessionOutcomeSourcePacket['files'] = []
  const missingFiles = [...selected.refused]
  let remaining = MAX_BYTES
  for (const sourcePath of paths) {
    const rel = relative(sourceWorkspace, sourcePath)
    if (
      rel.split(sep).some((part) => part.toLowerCase() === '.git') ||
      isImplicitFleetSecret(rel.split(sep).join('/'))
    ) {
      missingFiles.push(sourcePath)
      continue
    }
    const stat = await lstat(sourcePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    })
    if (!stat) {
      missingFiles.push(sourcePath)
      continue
    }
    if (stat.size > remaining) {
      throw new Error(
        `Source file ${JSON.stringify(sourcePath)} is ${stat.size} bytes; only ${remaining} bytes remain in the 10-MiB source packet. Reduce the captured source outputs to 10 MiB in total before saving Next again.`
      )
    }
    const canonical = await realpath(sourcePath)
    const expected = join(root, rel)
    if (
      !rel ||
      isAbsolute(rel) ||
      rel.split(sep).includes('..') ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      canonical !== expected
    ) {
      throw new Error('A source report file is not a regular file inside the source workspace.')
    }
    const capture = await captureFollowUpFiles(
      [sourcePath],
      null,
      {
        exists: async () => true,
        size: async () => stat.size,
        readExact: readExactHandoffFile
      },
      null,
      remaining
    )
    const pin = capture.pins[0]!
    const file = capture.bytes.get(pin.name)!
    if ((await realpath(sourcePath)) !== expected) {
      throw new Error('A source file moved while capturing its bytes.')
    }
    const dir = await packetDirectory(chain, sourceVersion)
    const name = `${createHash('sha256').update(sourcePath).digest('hex').slice(0, 16)}-${file.sha256}-${basename(sourcePath).slice(-32)}`
    const path = join(dir, name)
    await materializeOne(path, Buffer.from(file.contentBase64, 'base64'))
    files.push({ sourcePath, path, name: file.name, sha256: file.sha256, size: file.size })
    remaining -= file.size
  }
  for (const file of files) {
    const current = await readExactHandoffFile(file.sourcePath)
    if (current.sha256 !== file.sha256 || current.size !== file.size) {
      throw new Error('A source file changed while capturing its context.')
    }
  }
  return { files, missingFiles }
}

export async function verifySourcePacketFiles(chain: SessionChain): Promise<void> {
  const packet = chain.outcomeSet?.continuation.sourcePacket
  if (!packet) {
    return
  }
  const root = await realpath(chain.workspacePath)
  const expected = sessionChainStepOutputDir(root, chain.id, `source-${packet.sourceVersion}`)
  for (const pin of packet.files) {
    const inside = relative(expected, pin.path)
    if (
      !inside ||
      isAbsolute(inside) ||
      inside.split(sep).includes('..') ||
      (await realpath(pin.path)) !== pin.path
    ) {
      throw new Error('The retained source file moved outside its captured packet.')
    }
    const file = await readExactHandoffFile(pin.path)
    if (file.sha256 !== pin.sha256 || file.size !== pin.size) {
      throw new Error(
        'The retained source file changed; restore its captured bytes before continuing.'
      )
    }
  }
}
