export const OLDACS_ROUTINE_ID = '16c0a86d-0da8-46bd-abcc-23fbff90912b'
export const OLDACS_ACCOUNT_ID = 'act_1000000000000001'
export const OLDACS_COMPANY = 'omnirogue' as const

export type AdvertisingEvidenceScope = {
  routineId: string
  runId: string
  isCurrent(): boolean
}
