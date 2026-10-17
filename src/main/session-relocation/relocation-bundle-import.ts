/**
 * Export and import of one conversation's relocation bundle. Export freezes nothing itself: the
 * source host calls it only after positive exit evidence. Import files a verified bundle into the
 * destination's own provider home without launching anything and never overwrites a different
 * file, so staging twice is harmless and a same-named foreign conversation is refused.
 */

import { copyFileSync, constants, linkSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionHostRelocationProvider } from '../../shared/session-host-capabilities'
import type { SessionHostRelocationManifest } from '../../shared/session-host-payload-schema'
import {
  buildRelocationManifest,
  checkRelocationManifest,
  refuseRelocation,
  relocationFileDigest,
  verifyRelocationBundle
} from './relocation-bundle-files'
import { CLAUDE_RELOCATION_ADAPTER } from './relocation-claude-bundle'
import { CODEX_RELOCATION_ADAPTER } from './relocation-codex-bundle'
import {
  compareProviderVersions,
  type RelocationDestinationPlace,
  type RelocationImportPlan,
  type RelocationProviderAdapter,
  type RelocationResumeIdentity,
  type RelocationSourceConversation
} from './relocation-provider-adapter'

export const RELOCATION_PROVIDER_ADAPTERS: Record<
  SessionHostRelocationProvider,
  RelocationProviderAdapter
> = {
  claude: CLAUDE_RELOCATION_ADAPTER,
  codex: CODEX_RELOCATION_ADAPTER
}

export type ExportedRelocationBundle = {
  manifest: SessionHostRelocationManifest
  /** Manifest path → the source file; the bundle is read from these, never from a copy. */
  files: ReadonlyMap<string, string>
  /** The newest provider version that wrote the transcript; null when it records none. */
  writerVersion: string | null
}

export async function exportRelocationBundle(
  provider: SessionHostRelocationProvider,
  source: RelocationSourceConversation
): Promise<ExportedRelocationBundle> {
  const adapter = RELOCATION_PROVIDER_ADAPTERS[provider]
  const files = adapter.exportFiles(source)
  const { writerVersion } = await adapter.checkTranscript(source.transcriptPath, source.sessionId)
  const manifest = await buildRelocationManifest(provider, source.sessionId, files)
  return {
    manifest,
    files: new Map(files.map((file) => [file.path, file.absolute])),
    writerVersion
  }
}

export type StagedRelocation = {
  plan: RelocationImportPlan
  identity: RelocationResumeIdentity
  /** The newest provider version that wrote the transcript; null when it records none. */
  writerVersion: string | null
}

/**
 * Verifies the staged bundle, files it into the destination home and checks the result is
 * complete and resumable as exactly this identity. Launches nothing.
 */
export async function importRelocationBundle(input: {
  stagingRoot: string
  manifest: SessionHostRelocationManifest
  place: RelocationDestinationPlace
  /** The destination's provider CLI version; a transcript written by a newer one is refused. */
  providerVersion: string | null
}): Promise<StagedRelocation> {
  const { manifest, place } = input
  const adapter = RELOCATION_PROVIDER_ADAPTERS[manifest.provider]
  checkRelocationManifest(manifest)
  const plan = adapter.importPlan(manifest, place)
  await verifyRelocationBundle(input.stagingRoot, manifest)
  const transcript = plan.files.find((file) => file.absolute === plan.transcriptPath)!
  const { writerVersion } = await adapter.checkTranscript(
    join(input.stagingRoot, ...transcript.path.split('/')),
    manifest.providerSessionId
  )
  if (
    writerVersion &&
    input.providerVersion &&
    (compareProviderVersions(writerVersion, input.providerVersion) ?? 0) > 0
  ) {
    throw refuseRelocation(
      'not-eligible',
      `It was written by ${manifest.provider} ${writerVersion}, newer than ${input.providerVersion} on this computer, which may not read it. Update ${manifest.provider} here first. Nothing was staged.`
    )
  }
  const expected = new Map(manifest.files.map((file) => [file.path, file]))
  for (const file of plan.files) {
    const want = expected.get(file.path)!
    const present = await relocationFileDigest(file.absolute, file.path).catch(() => null)
    if (present) {
      if (present.sha256 !== want.sha256 || present.bytes !== want.bytes) {
        throw refuseRelocation(
          'ownership-conflict',
          `${file.path} already exists on this computer with different contents, so it was not overwritten. Nothing was staged.`
        )
      }
      continue
    }
    placeWithoutClobber(join(input.stagingRoot, ...file.path.split('/')), file.absolute)
  }
  for (const file of plan.files) {
    const want = expected.get(file.path)!
    const landed = await relocationFileDigest(file.absolute, file.path).catch(() => null)
    if (!landed || landed.sha256 !== want.sha256 || landed.bytes !== want.bytes) {
      throw refuseRelocation(
        'not-eligible',
        `${file.path} did not land intact in this computer's provider home. Nothing was resumed.`
      )
    }
  }
  await adapter.checkTranscript(plan.transcriptPath, manifest.providerSessionId)
  return { plan, identity: await adapter.resumeIdentity(plan, manifest, place), writerVersion }
}

/** Copy beside the destination, then hard-link into place: the link fails rather than clobbers. */
function placeWithoutClobber(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  const partial = `${to}.relocating-${process.pid}`
  rmSync(partial, { force: true })
  copyFileSync(from, partial, constants.COPYFILE_EXCL)
  try {
    linkSync(partial, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  } finally {
    rmSync(partial, { force: true })
  }
}
