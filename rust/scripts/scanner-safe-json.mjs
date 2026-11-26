// Golden fixtures that exercise the redactor (and the extra-CA TLS key) carry
// secret-shaped strings on purpose. Committed verbatim, they make GitHub push
// protection refuse the push (it did, for the first push of the Rust port).
// The generators that write them (redact-, reader- and extra-ca-golden.mjs)
// pass their JSON through scannerSafeJson() before writing it.
//
// scannerSafeJson() rewrites just those JSON string literals with \u escapes
// on every third character. JSON.parse and serde_json read back exactly the
// same value, but the raw bytes never hold more than two plain characters in
// a row, so no token pattern can match them. Everything else in the file is
// left byte-for-byte alone.
//
// The patterns are deliberately broad versions of the token shapes GitHub
// push protection looks for (no word boundaries: the fuzzer glues tokens onto
// other text). gitleaks decodes \u escapes and base64 before matching, so
// these fixtures stay on .gitleaks.toml's allowlist all the same.

const SECRET_SHAPED = [
  /(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{12,}/, // AWS access key ids
  /gl(?:pat|dt|rt|ft|soat|oas|agent|ptt|cbt|imt|ffct|cf|sct)-[\w.=-]{8,}/, // GitLab tokens
  /GR1348941[\w-]{12,}/, // GitLab runner registration tokens
  /gh[pousr]_[A-Za-z0-9]{16,}|github_pat_\w{16,}/, // GitHub tokens
  /xox[a-z](?:\.xox[a-z])?-[\w-]{4,}|xapp-[\w-]{8,}|xwfp-[\w-]{8,}/, // Slack tokens
  /hooks\.slack\.com\/(?:services|workflows|triggers)\//, // Slack webhooks
  /[rs]k_(?:live|test|prod)_\w{8,}/, // Stripe keys
  /sq0(?:atp|csp|idp)-[\w-]{12,}|EAAA[\w+/=%-]{30,}/, // Square tokens
  /AIza[\w-]{30,}/, // Google API keys
  /sk-ant-[\w-]{8,}/, // Anthropic keys
  /eyJ[\w-]{8,}\.[\w-]{4,}/, // JWTs
  /PRIVATE KEY/, // PEM private keys
  /(?:key|api|token|secret|passw(?:or)?d|auth)[^\w\s]{1,4}[\w.=+/-]{10,}/i, // key=value style secrets
];

// A PEM private key stored as base64 (the extra-CA golden keeps its PEMs so).
const isBase64PrivateKey = (value) =>
  value.length >= 40 &&
  /^[A-Za-z0-9+/=\s]+$/.test(value) &&
  Buffer.from(value, "base64").toString("latin1").includes("PRIVATE KEY");

export function isSecretShaped(value) {
  return SECRET_SHAPED.some((re) => re.test(value)) || isBase64PrivateKey(value);
}

function escapeValue(value) {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const std = JSON.stringify(ch).slice(1, -1); // ", \, control chars, lone surrogates
    if (std !== ch) out += std;
    else if (i % 3 === 0) out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `"${out}"`;
}

const LITERAL = /"(?:[^"\\]|\\.)*"/g;

export function scannerSafeJson(text) {
  return text.replace(LITERAL, (lit) => {
    const value = JSON.parse(lit);
    return isSecretShaped(value) ? escapeValue(value) : lit;
  });
}
