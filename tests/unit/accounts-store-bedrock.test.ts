import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addAccount,
  applyBedrockEnv,
  buildEnvForProfile,
  readAccountsPublic,
  readAccountsRaw,
  toPublic,
} from "@/lib/server/accounts-store";
import { describeBedrockConfig, normalizeBedrockConfig } from "@/lib/shared/accounts";

/**
 * Coverage for the `bedrock` account kind — Claude Code's own Amazon
 * Bedrock mode driven from the account switcher instead of the shell.
 *
 * Three things must hold:
 *   1. `buildEnvForProfile` for a bedrock profile emits exactly the env
 *      Claude Code's Bedrock mode reads (CLAUDE_CODE_USE_BEDROCK=1 + one
 *      credential source + region/model/prefix/base-url), and scrubs a
 *      parent-shell AWS credential that would otherwise outrank the
 *      profile's in the AWS default chain.
 *   2. The Anthropic kinds keep NOT scrubbing AWS_* — the agent's Bash tool
 *      inherits this env and users rely on AWS_PROFILE there — while still
 *      scrubbing CLAUDE_CODE_USE_BEDROCK so a shell opt-in can't hijack an
 *      OAuth profile (the pre-existing contract).
 *   3. Nothing secret reaches the public projection: the secret access key
 *      / Bedrock API key / session token never appear in `toPublic()`.
 */

const PARENT_ENV_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_MANTLE",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_BEDROCK_REGION_PREFIX",
  "ANTHROPIC_BEDROCK_BASE_URL",
] as const;

describe("accounts-store: bedrock account kind", () => {
  let tmp: string;
  let savedParent: Record<string, string | undefined>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "claudius-accounts-bedrock-"));
    process.env.CLAUDIUS_ACCOUNTS_DIR = tmp;
    savedParent = {};
    for (const k of PARENT_ENV_KEYS) {
      savedParent[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    delete process.env.CLAUDIUS_ACCOUNTS_DIR;
    for (const k of PARENT_ENV_KEYS) {
      if (savedParent[k] === undefined) delete process.env[k];
      else process.env[k] = savedParent[k];
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  test("aws-profile: injects the switch + AWS_PROFILE + region, scrubs a stray parent access key", async () => {
    // A parent-shell access key outranks AWS_PROFILE in the AWS default
    // chain — if it leaked, the profile's SSO identity would be ignored.
    process.env.AWS_ACCESS_KEY_ID = "AKIA-PARENT-LEAK";
    process.env.AWS_SECRET_ACCESS_KEY = "parent-secret-leak";
    process.env.AWS_DEFAULT_REGION = "eu-west-1";
    process.env.CLAUDE_CODE_USE_MANTLE = "1";

    const { profile } = await addAccount({
      label: "work-sso",
      kind: "bedrock",
      bedrock: { auth: "aws-profile", awsProfile: "work", region: "us-east-1" },
    });
    const env = await buildEnvForProfile(profile);

    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env.AWS_PROFILE).toBe("work");
    expect(env.AWS_REGION).toBe("us-east-1");
    expect(env.AWS_DEFAULT_REGION).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_MANTLE).toBeUndefined();
    // No Anthropic credential of any kind rides along.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // Per-profile config dir still provisioned, with no stale creds file.
    expect(env.CLAUDE_CONFIG_DIR).toContain(profile.id);
    await expect(fs.access(join(env.CLAUDE_CONFIG_DIR!, ".credentials.json"))).rejects.toThrow();
  });

  test("access-keys: secret is the secret access key; session token + model/prefix/base-url flow through", async () => {
    const { profile } = await addAccount({
      label: "keys",
      kind: "bedrock",
      secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      bedrock: {
        auth: "access-keys",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        sessionToken: "FwoGZXIvYXdzEBYaD-session",
        region: "us-west-2",
        model: "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc",
        regionPrefix: "global",
        baseUrl: "https://gateway.example.com",
      },
    });
    const env = await buildEnvForProfile(profile);
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(env.AWS_SESSION_TOKEN).toBe("FwoGZXIvYXdzEBYaD-session");
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBe(
      "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc",
    );
    expect(env.ANTHROPIC_BEDROCK_REGION_PREFIX).toBe("global");
    expect(env.ANTHROPIC_BEDROCK_BASE_URL).toBe("https://gateway.example.com");
  });

  test("bearer-token: secret becomes AWS_BEARER_TOKEN_BEDROCK", async () => {
    const { profile } = await addAccount({
      label: "api-key",
      kind: "bedrock",
      secret: "bedrock-api-key-xyz",
      bedrock: { auth: "bearer-token" },
    });
    const env = await buildEnvForProfile(profile);
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe("bedrock-api-key-xyz");
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    // No region configured ⇒ nothing forced; Claude Code falls back to
    // the AWS profile's region / us-east-1.
    expect(env.AWS_REGION).toBeUndefined();
  });

  test("ambient: only the switch is added — the parent's AWS chain is inherited untouched", async () => {
    process.env.AWS_PROFILE = "from-shell";
    process.env.AWS_REGION = "ap-southeast-2";
    const { profile } = await addAccount({
      label: "ambient",
      kind: "bedrock",
      bedrock: { auth: "ambient" },
    });
    const env = await buildEnvForProfile(profile);
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env.AWS_PROFILE).toBe("from-shell");
    expect(env.AWS_REGION).toBe("ap-southeast-2");
  });

  test("Anthropic kinds keep AWS_* for the Bash tool but scrub the Bedrock switch", async () => {
    process.env.AWS_PROFILE = "for-aws-cli";
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const { profile } = await addAccount({
      label: "sub",
      kind: "oauth-token",
      secret: "sk-ant-oat01-not-real",
    });
    const env = await buildEnvForProfile(profile);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-not-real");
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.AWS_PROFILE).toBe("for-aws-cli");
  });

  test("public projection never carries the secret access key, API key, or session token", async () => {
    await addAccount({
      label: "keys",
      kind: "bedrock",
      secret: "SECRET-ACCESS-KEY",
      bedrock: {
        auth: "access-keys",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        sessionToken: "SESSION-TOKEN",
        region: "us-east-1",
      },
    });
    await addAccount({
      label: "bearer",
      kind: "bedrock",
      secret: "BEDROCK-API-KEY",
      bedrock: { auth: "bearer-token", region: "eu-central-1" },
    });
    const pub = await readAccountsPublic();
    const json = JSON.stringify(pub);
    expect(json).not.toContain("SECRET-ACCESS-KEY");
    expect(json).not.toContain("SESSION-TOKEN");
    expect(json).not.toContain("BEDROCK-API-KEY");
    const keys = pub.profiles.find((p) => p.label === "keys")!;
    expect(keys.kind).toBe("bedrock");
    expect(keys.bedrock).toEqual({
      auth: "access-keys",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      region: "us-east-1",
    });
    expect(keys.secretPreview).toBe("us-east-1 · key MPLE");
    const bearer = pub.profiles.find((p) => p.label === "bearer")!;
    expect(bearer.secretPreview).toBe("eu-central-1 · API key");

    // Same guarantee via the exported projection used by POST /api/accounts.
    const raw = await readAccountsRaw();
    for (const p of raw.profiles) {
      expect(JSON.stringify(toPublic(p))).not.toMatch(/SECRET-ACCESS-KEY|SESSION-TOKEN|BEDROCK-API-KEY/);
    }
  });

  test("validation: per-auth-method requirements and shapes", async () => {
    await expect(
      addAccount({ label: "x", kind: "bedrock", bedrock: { auth: "aws-profile" } }),
    ).rejects.toThrow(/AWS profile name required/);
    await expect(
      addAccount({
        label: "x",
        kind: "bedrock",
        bedrock: { auth: "access-keys", accessKeyId: "AKIA" },
      }),
    ).rejects.toThrow(/secret access key required/);
    await expect(
      addAccount({ label: "x", kind: "bedrock", bedrock: { auth: "bearer-token" } }),
    ).rejects.toThrow(/Bedrock API key required/);
    await expect(
      addAccount({
        label: "x",
        kind: "bedrock",
        bedrock: { auth: "ambient", region: "not a region" },
      }),
    ).rejects.toThrow(/AWS region/);
    await expect(
      addAccount({
        label: "x",
        kind: "bedrock",
        bedrock: { auth: "ambient", baseUrl: "ftp://nope" },
      }),
    ).rejects.toThrow(/http\(s\) URL/);
    await expect(
      addAccount({
        label: "x",
        kind: "bedrock",
        // Wrong enum member, deliberately typed loosely.
        bedrock: { auth: "ambient", regionPrefix: "mars" as unknown as "us" },
      }),
    ).rejects.toThrow(/regionPrefix/);
    // Missing config block entirely.
    await expect(addAccount({ label: "x", kind: "bedrock" })).rejects.toThrow(/bedrock\.auth/);
    // The Anthropic kinds still require a secret.
    await expect(addAccount({ label: "x", kind: "api-key" })).rejects.toThrow(/secret required/);
    // Nothing was persisted by the failures.
    expect((await readAccountsRaw()).profiles).toEqual([]);
  });

  test("on-disk rows: a bedrock row without its config block is dropped on read", async () => {
    await addAccount({
      label: "good",
      kind: "bedrock",
      bedrock: { auth: "ambient" },
    });
    const path = join(tmp, "accounts.json");
    const state = JSON.parse(await fs.readFile(path, "utf8")) as {
      profiles: Array<Record<string, unknown>>;
    };
    state.profiles.push({
      id: "acc_broken",
      label: "broken",
      kind: "bedrock",
      secret: "",
      createdAt: new Date().toISOString(),
    });
    await fs.writeFile(path, JSON.stringify(state));
    const raw = await readAccountsRaw();
    expect(raw.profiles.map((p) => p.label)).toEqual(["good"]);
  });

  test("applyBedrockEnv refuses non-bedrock profiles", () => {
    expect(() =>
      applyBedrockEnv(
        {} as NodeJS.ProcessEnv,
        {
          id: "acc_x",
          label: "x",
          kind: "api-key",
          secret: "sk",
          createdAt: "",
        },
      ),
    ).toThrow(/not a bedrock profile/);
  });

  test("normalizeBedrockConfig trims and drops empties; describeBedrockConfig is secret-free", () => {
    const cfg = normalizeBedrockConfig(
      { auth: "aws-profile", awsProfile: "  work ", region: " us-east-1 ", model: "  ", baseUrl: "" },
      "",
    );
    expect(cfg).toEqual({ auth: "aws-profile", awsProfile: "work", region: "us-east-1" });
    expect(describeBedrockConfig(cfg)).toBe("us-east-1 · profile work");
    expect(describeBedrockConfig({ auth: "ambient" })).toBe("ambient AWS env");
    expect(
      describeBedrockConfig({ auth: "bearer-token", region: "eu-west-1", model: "us.anthropic.claude-sonnet-4-6" }),
    ).toBe("eu-west-1 · API key · us.anthropic.claude-sonnet-4-6");
  });
});
