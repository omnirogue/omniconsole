/**
 * The deliverable check's switch (W22-20, approved by Sal 17 Oct 2026). `shadow` (Watch only) is the
 * default: it checks and records, and sends nothing. `on` asks the same agent to finish what is
 * missing, up to `maxRepairs` times per request. `OMNI_DELIVERABLE_VERIFIER_DISABLED=1` in main's
 * environment turns it off whatever the setting says.
 */

export const DELIVERABLE_VERIFIER_MODES = ['off', 'shadow', 'on'] as const
export type DeliverableVerifierMode = (typeof DELIVERABLE_VERIFIER_MODES)[number]

export type DeliverableVerifierSettings = {
  mode: DeliverableVerifierMode
  /** Repair prompts per request, 1–3. */
  maxRepairs: number
}

export const DELIVERABLE_VERIFIER_DISABLED_ENV = 'OMNI_DELIVERABLE_VERIFIER_DISABLED'
export const DELIVERABLE_VERIFIER_REPAIRS_MIN = 1
export const DELIVERABLE_VERIFIER_REPAIRS_MAX = 3
export const DELIVERABLE_VERIFIER_REPAIRS_DEFAULT = 2

export function getDefaultDeliverableVerifierSettings(): DeliverableVerifierSettings {
  return { mode: 'shadow', maxRepairs: DELIVERABLE_VERIFIER_REPAIRS_DEFAULT }
}

const OFF: DeliverableVerifierSettings = {
  mode: 'off',
  maxRepairs: DELIVERABLE_VERIFIER_REPAIRS_DEFAULT
}

function isDisabledByEnv(env: Record<string, string | undefined> | undefined): boolean {
  const value = env?.[DELIVERABLE_VERIFIER_DISABLED_ENV]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

/** Missing reads as the default; anything present but unreadable reads as off. */
export function normalizeDeliverableVerifierSettings(
  raw: unknown,
  env?: Record<string, string | undefined>
): DeliverableVerifierSettings {
  if (isDisabledByEnv(env)) {
    return OFF
  }
  if (raw === undefined || raw === null) {
    return getDefaultDeliverableVerifierSettings()
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return OFF
  }
  const value = raw as Record<string, unknown>
  const mode = DELIVERABLE_VERIFIER_MODES.find((candidate) => candidate === value.mode)
  if (!mode) {
    return OFF
  }
  if (value.maxRepairs === undefined) {
    return { mode, maxRepairs: DELIVERABLE_VERIFIER_REPAIRS_DEFAULT }
  }
  const repairs = value.maxRepairs
  if (
    typeof repairs !== 'number' ||
    !Number.isInteger(repairs) ||
    repairs < DELIVERABLE_VERIFIER_REPAIRS_MIN ||
    repairs > DELIVERABLE_VERIFIER_REPAIRS_MAX
  ) {
    return OFF
  }
  return { mode, maxRepairs: repairs }
}
