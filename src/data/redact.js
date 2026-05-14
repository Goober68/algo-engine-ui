// Deep-copy a value (object / array / scalar) replacing values of any
// secret-shaped key with the literal string "*****". Match is by key
// NAME (case-insensitive substring), not by value content: if the key
// contains 'secret', 'token', 'password', 'authorization', or
// 'api[-_]?key', the value is redacted regardless of type.
//
// Used at audit display sites (WebhookPanel, OrdersPanel) so a relay
// payload that happens to carry the Tradovate webhook secret, an
// HMAC signature, or any future credential field never lands in the
// operator's clipboard via copy-paste of "raw payload" or tooltip
// text. Belt-and-suspenders alongside the coord-side rule that
// secrets shouldn't ride in audit bodies in the first place.

const SENSITIVE_RE = /(secret|token|password|authorization|api[-_]?key)/i;

export function redactSecrets(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_RE.test(k) ? '*****' : redactSecrets(v);
  }
  return out;
}
