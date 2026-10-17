import { z } from 'zod'
import { CLAUDE_AUTH_ENV_VARS } from './claude-auth-env'
import type { PrimaryAiBillingMode } from './omnirogue-account'

/** Distinct method: an older relay must refuse rather than ignore account routing. */
export const SESSION_PREP_ACCOUNT_METHOD = 'agent.prepareSessionAccount'
export const sessionPrepAccountRequest = z
  .object({
    provider: z.enum(['claude', 'codex']),
    model: z.string().max(200).optional()
  })
  .strict()
export const sessionPrepAccountResult = z
  .object({
    provider: z.enum(['claude', 'codex']),
    pinConfigDir: z.boolean(),
    configRoot: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) =>
          !value.includes('\0') && (value.startsWith('/') || /^[A-Za-z]:[\\/]|^\\\\/.test(value)),
        'An absolute execution-host profile directory is required.'
      ),
    readingAt: z.number().finite().positive(),
    ageAtReplyMs: z.number().finite().min(0).max(60_000),
    processingMs: z.number().finite().min(0).max(180_000),
    remainingPercent: z.number().finite().gt(0).max(100),
    /** A pool setup-token slot: the host reads this file into CLAUDE_CODE_OAUTH_TOKEN at launch. */
    oauthTokenFile: z
      .string()
      .max(4096)
      .refine(isPoolOAuthTokenFile, 'A pool slot token file path is required.')
      .optional()
  })
  .strict()
export type SessionPrepAccount = z.infer<typeof sessionPrepAccountResult>

export type SessionPrepAccountEnvOptions = {
  billing?: PrimaryAiBillingMode
  gatewayActive?: boolean
}

/**
 * Names the host-side token file instead of carrying the token: the launch reads it on the
 * execution host (shell expansion for terminals, the relay for one-shot helpers), so the
 * credential never crosses the SSH relay or reaches the controller.
 */
export const ACCOUNT_OAUTH_TOKEN_FILE_ENV = 'ORCA_ACCOUNT_OAUTH_TOKEN_FILE'

/** `<home>/.claude-accounts/<pool>/slot-<n>/.oauth-token`, the estate pool layout (fleet `pool`). */
export function isPoolOAuthTokenFile(path: string): boolean {
  return (
    /^\/(?:[^/\0\r\n]+\/)+\.claude-accounts\/[A-Za-z0-9_-]+\/slot-\d+\/\.oauth-token$/.test(path) &&
    !path.split('/').some((part) => part === '.' || part === '..')
  )
}

/** Pin the chosen host profile; inherited API credentials must not override its subscription unless routing via the OmniRogue Gateway. */
export function sessionPrepAccountEnv(
  account: SessionPrepAccount,
  options?: SessionPrepAccountEnvOptions
): Record<string, string> {
  const isGateway =
    options?.billing === 'omnirogue-credits' || options?.gatewayActive === true
  if (account.provider !== 'claude') {
    if (isGateway) {
      return {
        CODEX_HOME: account.configRoot
      }
    }
    return {
      CODEX_HOME: account.configRoot,
      OPENAI_API_KEY: '',
      CODEX_API_KEY: '',
      OPENAI_BASE_URL: ''
    }
  }
  // Why the default config for a pool slot: its directory holds only the token and a minimal
  // settings file, so the session keeps the host's rules, hooks and skills and takes only its
  // subscription from the slot (the same shape fleet jobs use).
  const token = account.oauthTokenFile
  if (isGateway) {
    return {
      CLAUDE_CONFIG_DIR: account.pinConfigDir && !token ? account.configRoot : ''
    }
  }
  return {
    // Empty clears inherited pins without moving the default login/config namespace; the
    // launch command unsets empty keys rather than exporting them blank.
    CLAUDE_CONFIG_DIR: account.pinConfigDir && !token ? account.configRoot : '',
    ...Object.fromEntries(CLAUDE_AUTH_ENV_VARS.map((key) => [key, ''])),
    ANTHROPIC_CUSTOM_HEADERS: '',
    CLAUDE_CODE_USE_BEDROCK: '',
    CLAUDE_CODE_USE_VERTEX: '',
    ...(token ? { [ACCOUNT_OAUTH_TOKEN_FILE_ENV]: token } : {})
  }
}

