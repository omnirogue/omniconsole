/**
 * Estate folders the delivery path reads, each overridable by an environment variable (as the
 * estate hosts file is): the `choices` sidecars a review page's publisher wrote, the Work root and
 * the folder holding each repository's main checkout, where a replacement starts when a worktree is gone.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export const ESTATE_WORK_DIR_ENV = 'OMNI_ESTATE_WORK_DIR'
export const ESTATE_CHOICES_DIR_ENV = 'OMNI_ESTATE_CHOICES_DIR'
export const ESTATE_PROTOTYPES_DIR_ENV = 'OMNI_ESTATE_PROTOTYPES_DIR'

export type WorkDeliveryEstatePaths = {
  workRoot: string
  choicesDir: string
  /** `<prototypesDir>/<repo>` is the main checkout of `<parent>/<repo>-worktrees/<branch>`. */
  prototypesDir: string
}

export function workDeliveryEstatePaths(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): WorkDeliveryEstatePaths {
  const workRoot = env[ESTATE_WORK_DIR_ENV] || join(home, 'Work')
  return {
    workRoot,
    choicesDir: env[ESTATE_CHOICES_DIR_ENV] || join(workRoot, 'Ops', 'var', 'choices'),
    prototypesDir: env[ESTATE_PROTOTYPES_DIR_ENV] || join(workRoot, 'OmniAgentOS', 'Prototypes')
  }
}
