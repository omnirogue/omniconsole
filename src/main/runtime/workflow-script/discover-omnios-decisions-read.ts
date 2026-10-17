import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DISCOVER_DECISIONS_FILE,
  parseDiscoverDecisions,
  type DiscoverDecision
} from '../../../shared/discover-omnios-decisions'

/** Larger than any page's decisions; a bigger file is not one decide.sh wrote. */
const DECISIONS_MAX_BYTES = 256 * 1024

/** A run's recorded picks (decide.sh); none when its page was never answered or the file is unreadable. */
export function readDiscoverDecisions(root: string, executionId: string): DiscoverDecision[] {
  try {
    const text = readFileSync(join(root, executionId, DISCOVER_DECISIONS_FILE), 'utf8')
    return text.length > DECISIONS_MAX_BYTES ? [] : parseDiscoverDecisions(JSON.parse(text))
  } catch {
    return []
  }
}
