// ─── Is the value beside a credential label a credential? ───────────────────
// `password: string`, `token?: string`, `apiKey: process.env.X`, `secret: null`
// are ordinary source text; a session that reads a TypeScript interface must
// not be withheld for it. A hit needs a value that looks like a credential:
// quoted, or a bare literal of eight or more characters, and in neither case a
// type name, keyword or placeholder.

const TYPE_OR_KEYWORD =
  /^(?:string|number|boolean|null|undefined|true|false|none|any|object|unknown|never|void|symbol|bigint|str|int|float|bool|dict|list|optional|required|text|varchar|json)$/i

const PLACEHOLDER =
  /^(?:<[^>]*>|\$\{[^}]*\}?|\$[A-Z_][A-Z0-9_]*|process\.env(?:\.|\[).*|os\.environ.*|env\(.*|getenv\(.*|\*{3,}|x{3,}|redacted|\[redacted[^\]]*\]|your[-_ ].*|example.*|placeholder.*|changeme|todo|tbd|n\/a|\.{3})$/i

/** Type syntax after the label: `secret?: string`, or `token: MyToken;` — an
 *  optional marker, or a bare identifier ending the line with `;` (an interface
 *  or class field; an object literal ends with `,`). */
const TYPE_ANNOTATION_AFTER_LABEL = /^\s*(?:\?\s*:|:\s*[A-Za-z_$][\w$<>[\]|&. ]*;\s*$)/

const NON_SECRET_PAIRS: { label: RegExp; value: RegExp }[] = [
  // fetch's `credentials` option names a policy, not a credential.
  { label: /^credentials$/, value: /^(?:omit|include|same-?origin)$/i },
  // OAuth's `token_type` names a scheme.
  { label: /^tokentype$/, value: /^(?:bearer|mac|basic)$/i },
  // A count of tokens is a number, not a token.
  { label: /(?:tokens|tokencount|tokensused|maxtokens|numtokens)$/, value: /^\d+$/ },
  // A duration beside a credential label is metadata: cookieMaxAge, token_ttl,
  // PASSWORD_RESET_TIMEOUT, *_lifetime, *_expiry. Exact suffixes, numeric values only.
  {
    label: /(?:maxage|age|ttl|lifetime|expiry|expires|expiration|timeout)$/,
    value: /^\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|m|min|mins|h|hr|hrs|d|days?)?$/i
  },
  // The shell's PWD is a path; a `pwd` label with anything else is judged like `password`.
  {
    label: /^pwd$/,
    // Real path forms only: `/…`, `~/…`, `./…`, `../…`, a drive + slash, or exactly `.`, `..`, `~`.
    value: /^(?:(?:\/|~\/|\.\/|\.\.\/|[A-Za-z]:[\\/])\S*|\.|\.\.|~)$/
  }
]

/** Labels that name a reference to a secret rather than the secret itself. */
const REFERENCE_LABEL = /^(?:secretname|secretref|secretkeyref)$/

function normalizedLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** A label that names a reference to a secret (K8s), never the secret itself. */
export function isReferenceLabel(label: string): boolean {
  return REFERENCE_LABEL.test(normalizedLabel(label))
}

/** Exact non-secret label + value pairs: a fetch policy, an OAuth scheme, a K8s
 *  secret reference, the shell's `PWD`, a token count. Never the words alone. */
export function isKnownNonSecretPair(label: string, value: string): boolean {
  const key = normalizedLabel(label)
  if (REFERENCE_LABEL.test(key)) {
    return true
  }
  const literal = value
    .trim()
    .replace(/^(["'`])(.*)\1$/s, '$2')
    .trim()
  return NON_SECRET_PAIRS.some((pair) => pair.label.test(key) && pair.value.test(literal))
}

export function looksLikeCredentialValue(raw: string, label = ''): boolean {
  let value = raw.trim()
  if (!value) {
    return false
  }
  if (label && isKnownNonSecretPair(label, value)) {
    return false
  }
  // `Bearer eyJ…` / `Token abc…`: the scheme is not the secret, what follows is.
  const scheme = /^(?:bearer|token|basic)\s+(\S+)/i.exec(value)
  if (scheme) {
    value = scheme[1]!
  }
  const quoted = /^(["'`])(.*)\1$/s.exec(value)
  const literal = quoted ? quoted[2]!.trim() : value
  if (!literal) {
    return false
  }
  if (TYPE_OR_KEYWORD.test(literal) || PLACEHOLDER.test(literal)) {
    return false
  }
  // A bare PIN (`password: 482913`) is short but still a secret: digits count from four.
  return quoted ? literal.length >= 4 : literal.length >= 8 || /^\d{4,}$/.test(literal)
}

/** The text right after a label, up to the end of its line, and whether it is type syntax. */
export function isTypeAnnotation(afterLabel: string): boolean {
  return TYPE_ANNOTATION_AFTER_LABEL.test(afterLabel)
}
