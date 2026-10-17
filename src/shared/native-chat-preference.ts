export const DEFAULT_NATIVE_CHAT_ENABLED = true

/** Preserve saved opt-outs while enabling conversation views for new profiles. */
export function nativeChatEnabledByPreference(
  settings: { experimentalNativeChat?: boolean } | null | undefined
): boolean {
  return settings?.experimentalNativeChat ?? DEFAULT_NATIVE_CHAT_ENABLED
}
