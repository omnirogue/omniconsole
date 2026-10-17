/** A full provider/model id; display labels cannot establish provider identity. */
export function parseNativeChatSessionModel(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= 640 &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*\/\S+$/.test(value) &&
    [...value].every(
      (character) => character.charCodeAt(0) >= 33 && character.charCodeAt(0) !== 127
    )
    ? value
    : undefined
}
