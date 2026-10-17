import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs'
import { decisionEnvironmentKilled, parseDecisionConfiguration } from './decision-configuration'
import { isLiveRoutineDecisionEnabled } from './routine-decision-mode'

const MAX_CONFIGURATION_BYTES = 32 * 1024

function assertRegularConfiguration(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > MAX_CONFIGURATION_BYTES
  ) {
    throw new Error('invalid')
  }
}

function sameConfigurationFile(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  )
}

function readCurrentConfiguration(path: string) {
  let descriptor: number | undefined
  try {
    const before = lstatSync(path)
    assertRegularConfiguration(before)
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0)
    )
    const stat = fstatSync(descriptor)
    assertRegularConfiguration(stat)
    if (!sameConfigurationFile(before, stat)) {
      throw new Error('changed')
    }
    const bytes = Buffer.alloc(MAX_CONFIGURATION_BYTES + 1)
    const count = readSync(descriptor, bytes, 0, bytes.length, 0)
    const after = fstatSync(descriptor)
    const current = lstatSync(path)
    assertRegularConfiguration(after)
    assertRegularConfiguration(current)
    if (
      count !== stat.size ||
      !sameConfigurationFile(stat, after) ||
      !sameConfigurationFile(after, current)
    ) {
      throw new Error('changed')
    }
    return parseDecisionConfiguration(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)))
    )
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
  }
}

/** Consequential local sends re-read the kill switch without an await before the native call. */
export function assertDecisionLiveActionEnabled(path: string, routineId: string): void {
  try {
    if (decisionEnvironmentKilled(process.env)) {
      throw new Error('disabled')
    }
    const configuration = readCurrentConfiguration(path)
    if (
      decisionEnvironmentKilled(process.env) ||
      !isLiveRoutineDecisionEnabled(configuration, routineId, 'advertising.routine')
    ) {
      throw new Error('disabled')
    }
  } catch {
    throw new Error('Structured advertising actions are disabled or unavailable.')
  }
}
