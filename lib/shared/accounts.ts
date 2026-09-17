/**
 * Account-switcher types shared between the server store
 * (`lib/server/accounts-store.ts`) and the /usage page. Kept here — not
 * in the store — because the store is Node-only (fs, homedir) and the
 * client must never import it.
 *
 * Nothing in this module touches secrets: it's shapes and pure
 * validation helpers only.
 */

/**
 * Auth kind a profile carries.
 *
 * - `oauth-token`: long-lived `CLAUDE_CODE_OAUTH_TOKEN` — what
 *   `claude setup-token` emits. Backed by the user's Anthropic
 *   subscription (Pro/Max).
 * - `api-key`: pay-per-token `ANTHROPIC_API_KEY` (`sk-ant-...`).
 * - `bedrock`: Claude via **Amazon Bedrock**. Claude Code's own Bedrock
 *   mode (`CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials) — the SDK
 *   harness is unchanged, only the inference backend moves. Billing
 *   lands on the AWS account; no Anthropic credential is involved.
 */
export type AccountKind = "oauth-token" | "api-key" | "bedrock";

/**
 * How a Bedrock profile authenticates to AWS. Mirrors the options
 * Claude Code's own `/setup-bedrock` wizard offers.
 *
 * - `aws-profile`: `AWS_PROFILE=<name>` — SSO / named profile from
 *   `~/.aws`. The profile's own region applies unless `region` is set.
 * - `access-keys`: `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`
 *   (+ optional `AWS_SESSION_TOKEN`).
 * - `bearer-token`: `AWS_BEARER_TOKEN_BEDROCK` — an Amazon Bedrock API
 *   key. Simplest option; no IAM role needed.
 * - `ambient`: inherit whatever the AWS default credential chain
 *   already resolves in Claudius's own process env (instance role,
 *   `aws login`, exported keys, …). Nothing is scrubbed or injected
 *   beyond `CLAUDE_CODE_USE_BEDROCK=1` itself.
 */
export type BedrockAuthMethod = "aws-profile" | "access-keys" | "bearer-token" | "ambient";

/**
 * Cross-region inference-profile prefix Claude Code tries first when it
 * resolves its built-in default models (`ANTHROPIC_BEDROCK_REGION_PREFIX`).
 * Optional — unset lets Claude Code derive it from the region.
 */
export type BedrockRegionPrefix = "us" | "eu" | "apac" | "jp" | "au" | "global";

export const BEDROCK_REGION_PREFIXES: readonly BedrockRegionPrefix[] = [
  "us",
  "eu",
  "apac",
  "jp",
  "au",
  "global",
];

export const BEDROCK_AUTH_METHODS: readonly BedrockAuthMethod[] = [
  "aws-profile",
  "access-keys",
  "bearer-token",
  "ambient",
];

/**
 * Non-secret Bedrock settings stored on the profile. The secret half
 * (secret access key / bearer token) lives in `AccountProfile.secret`
 * like every other kind; the optional session token is secret too and
 * is stripped by `toPublic` on the server.
 */
export type BedrockConfig = {
  auth: BedrockAuthMethod;
  /** `AWS_REGION`. Optional — falls back to the AWS profile's region / us-east-1. */
  region?: string;
  /** `AWS_PROFILE` — only for `auth: "aws-profile"`. */
  awsProfile?: string;
  /** `AWS_ACCESS_KEY_ID` — only for `auth: "access-keys"`. */
  accessKeyId?: string;
  /** `AWS_SESSION_TOKEN` — only for `auth: "access-keys"`. SECRET; never sent to the client. */
  sessionToken?: string;
  /**
   * `ANTHROPIC_MODEL` — Bedrock inference-profile id
   * (`us.anthropic.claude-sonnet-4-6`) or application-inference-profile
   * ARN. Applies when a session is started without an explicit model;
   * a model chosen in the picker (`--model`) wins, and Claude Code maps
   * Anthropic-format ids to Bedrock profiles itself (≥ 2.1.200).
   */
  model?: string;
  /** `ANTHROPIC_BEDROCK_REGION_PREFIX`. */
  regionPrefix?: BedrockRegionPrefix;
  /** `ANTHROPIC_BEDROCK_BASE_URL` — custom endpoint / gateway. */
  baseUrl?: string;
};

/** Client-safe view of `BedrockConfig` — secrets removed. */
export type PublicBedrockConfig = Omit<BedrockConfig, "sessionToken">;

export const ACCOUNT_KIND_LABEL: Record<AccountKind, string> = {
  "oauth-token": "Subscription (OAuth)",
  "api-key": "API key",
  bedrock: "Amazon Bedrock",
};

export const BEDROCK_AUTH_LABEL: Record<BedrockAuthMethod, string> = {
  "aws-profile": "AWS profile (SSO / named profile)",
  "access-keys": "Access key + secret",
  "bearer-token": "Bedrock API key",
  ambient: "Credentials already in the environment",
};

export function isAccountKind(x: unknown): x is AccountKind {
  return x === "oauth-token" || x === "api-key" || x === "bedrock";
}

export function isBedrockAuthMethod(x: unknown): x is BedrockAuthMethod {
  return typeof x === "string" && (BEDROCK_AUTH_METHODS as readonly string[]).includes(x);
}

export function isBedrockRegionPrefix(x: unknown): x is BedrockRegionPrefix {
  return typeof x === "string" && (BEDROCK_REGION_PREFIXES as readonly string[]).includes(x);
}

/**
 * Loose AWS region shape (`us-east-1`, `eu-central-1`, `us-gov-west-1`,
 * `ap-southeast-2`). Claude Code itself treats anything with a slash,
 * dot or space as "unset" — we're a bit stricter so a typo surfaces in
 * the form rather than as a silent fallback to us-east-1.
 */
export function isValidAwsRegion(s: string): boolean {
  return /^[a-z]{2}(-[a-z]+)+-\d+$/.test(s);
}

/**
 * Validate + normalize a Bedrock config coming off the wire. Returns the
 * trimmed config or throws with a message suitable for the Add form.
 * `secret` is the paired `AccountProfile.secret` (secret access key or
 * bearer token) — required or forbidden depending on the auth method.
 */
export function normalizeBedrockConfig(
  input: Partial<BedrockConfig> | undefined,
  secret: string,
): BedrockConfig {
  if (!input || !isBedrockAuthMethod(input.auth)) {
    throw new Error("bedrock.auth must be one of: aws-profile, access-keys, bearer-token, ambient");
  }
  const trim = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  };
  const region = trim(input.region);
  if (region && !isValidAwsRegion(region)) {
    throw new Error(`"${region}" doesn't look like an AWS region (e.g. us-east-1)`);
  }
  const cfg: BedrockConfig = { auth: input.auth };
  if (region) cfg.region = region;

  switch (input.auth) {
    case "aws-profile": {
      const awsProfile = trim(input.awsProfile);
      if (!awsProfile) throw new Error("AWS profile name required");
      cfg.awsProfile = awsProfile;
      break;
    }
    case "access-keys": {
      const accessKeyId = trim(input.accessKeyId);
      if (!accessKeyId) throw new Error("AWS access key id required");
      if (!secret) throw new Error("AWS secret access key required");
      cfg.accessKeyId = accessKeyId;
      const sessionToken = trim(input.sessionToken);
      if (sessionToken) cfg.sessionToken = sessionToken;
      break;
    }
    case "bearer-token": {
      if (!secret) throw new Error("Bedrock API key required");
      break;
    }
    case "ambient":
      break;
  }

  const model = trim(input.model);
  if (model) cfg.model = model;
  // Tolerate the form's "" (= derive from region) and a missing key; any
  // other value must be a real prefix.
  const regionPrefix: unknown = input.regionPrefix;
  if (regionPrefix !== undefined && regionPrefix !== null && regionPrefix !== "") {
    if (!isBedrockRegionPrefix(regionPrefix)) {
      throw new Error("regionPrefix must be one of: us, eu, apac, jp, au, global");
    }
    cfg.regionPrefix = regionPrefix;
  }
  const baseUrl = trim(input.baseUrl);
  if (baseUrl) {
    let ok = false;
    try {
      const u = new URL(baseUrl);
      ok = u.protocol === "https:" || u.protocol === "http:";
    } catch {
      ok = false;
    }
    if (!ok) throw new Error("baseUrl must be an http(s) URL");
    cfg.baseUrl = baseUrl;
  }
  return cfg;
}

/**
 * One-line, secret-free summary for the accounts list row, e.g.
 * `us-east-1 · profile work-sso` / `eu-central-1 · API key` / `ambient AWS env`.
 */
export function describeBedrockConfig(cfg: PublicBedrockConfig): string {
  const parts: string[] = [];
  if (cfg.region) parts.push(cfg.region);
  switch (cfg.auth) {
    case "aws-profile":
      parts.push(`profile ${cfg.awsProfile ?? "?"}`);
      break;
    case "access-keys":
      parts.push(cfg.accessKeyId ? `key ${cfg.accessKeyId.slice(-4)}` : "access keys");
      break;
    case "bearer-token":
      parts.push("API key");
      break;
    case "ambient":
      parts.push("ambient AWS env");
      break;
  }
  if (cfg.model) parts.push(cfg.model);
  return parts.join(" · ");
}
