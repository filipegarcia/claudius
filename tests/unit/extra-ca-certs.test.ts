import { describe, expect, it, vi } from "vitest";

import { expandCaPath, resolveExtraCaCerts } from "@/lib/server/extra-ca-certs";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const ROOTS = ["ROOT-A", "ROOT-B"];

describe("resolveExtraCaCerts (CC 2.1.307 — dictation honours NODE_EXTRA_CA_CERTS from user settings)", () => {
  it("adds the settings-only CA file on top of the bundled roots", async () => {
    const readFile = vi.fn(async () => PEM);
    const ca = await resolveExtraCaCerts({
      processEnv: {},
      readUserSettingsEnv: async () => ({ NODE_EXTRA_CA_CERTS: "~/certs/corp.pem" }),
      readFile,
      home: "/home/u",
      roots: ROOTS,
    });
    expect(readFile).toHaveBeenCalledWith("/home/u/certs/corp.pem");
    expect(ca).toEqual([...ROOTS, PEM]);
  });

  it("leaves default trust alone when the real env already sets it (Node loaded it at startup)", async () => {
    const readUserSettingsEnv = vi.fn(async () => ({ NODE_EXTRA_CA_CERTS: "/x.pem" }));
    const ca = await resolveExtraCaCerts({
      processEnv: { NODE_EXTRA_CA_CERTS: "/etc/corp.pem" },
      readUserSettingsEnv,
    });
    expect(ca).toBeUndefined();
    expect(readUserSettingsEnv).not.toHaveBeenCalled();
  });

  it("returns undefined when neither source names a bundle", async () => {
    expect(await resolveExtraCaCerts({ processEnv: {}, readUserSettingsEnv: async () => undefined })).toBeUndefined();
    expect(
      await resolveExtraCaCerts({ processEnv: {}, readUserSettingsEnv: async () => ({ NODE_EXTRA_CA_CERTS: "  " }) }),
    ).toBeUndefined();
  });

  it("falls back to default trust when the file or settings can't be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await resolveExtraCaCerts({
        processEnv: {},
        readUserSettingsEnv: async () => ({ NODE_EXTRA_CA_CERTS: "/missing.pem" }),
        readFile: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBeUndefined();
    expect(
      await resolveExtraCaCerts({
        processEnv: {},
        readUserSettingsEnv: async () => {
          throw new SyntaxError("bad json");
        },
      }),
    ).toBeUndefined();
    expect(
      await resolveExtraCaCerts({
        processEnv: {},
        readUserSettingsEnv: async () => ({ NODE_EXTRA_CA_CERTS: "/not-a-cert.txt" }),
        readFile: async () => "hello",
      }),
    ).toBeUndefined();
    warn.mockRestore();
  });
});

describe("expandCaPath", () => {
  it("expands ~ and resolves relative paths against home", () => {
    expect(expandCaPath("~/a.pem", "/h")).toBe("/h/a.pem");
    expect(expandCaPath("~", "/h")).toBe("/h");
    expect(expandCaPath("certs/a.pem", "/h")).toBe("/h/certs/a.pem");
    expect(expandCaPath("/etc/a.pem", "/h")).toBe("/etc/a.pem");
  });
});
