import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { ensureAuthKeys, generateAuthKeys } from "./ensure-auth-keys.ts";

// Run from the repository root: pnpm exec vp test run --root examples/tanstack-ssr/scripts
function fakeConvex(values: Record<string, string>) {
  const calls: { args: string[]; input: string | undefined }[] = [];
  return {
    calls,
    run: (args: string[], input?: string) => {
      calls.push({ args, input });
      const name = args[0] === "env" && args[1] === "get" ? args[2] : undefined;
      return name === undefined ? "" : (values[name] ?? "");
    },
  };
}

describe("ensure-auth-keys", () => {
  it("generates a matching RS256 pair in the Convex Auth v2 format", () => {
    const keys = generateAuthKeys();
    const pem = Buffer.from(keys.AUTH_PRIVATE_KEY, "base64").toString("utf8");
    expect(pem).toMatch(
      /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n$/,
    );
    const privateKey = createPrivateKey(pem);
    const publicKey = createPublicKey(privateKey);
    expect(privateKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    const jwks: unknown = JSON.parse(keys.AUTH_JWKS);
    expect(jwks).toEqual({
      keys: [
        {
          ...publicKey.export({ format: "jwk" }),
          kid: expect.stringMatching(/^[0-9a-f-]{36}$/),
          alg: "RS256",
          use: "sig",
        },
      ],
    });
    const message = Buffer.from("Convex Auth key check");
    expect(verify("RSA-SHA256", message, publicKey, sign("RSA-SHA256", message, privateKey))).toBe(
      true,
    );
  });

  it("writes both absent keys together through stdin without deployment selectors", () => {
    const convex = fakeConvex({});
    expect(ensureAuthKeys(convex.run)).toBe("created");
    expect(convex.calls.map((call) => call.args)).toEqual([
      ["env", "get", "AUTH_PRIVATE_KEY"],
      ["env", "get", "AUTH_JWKS"],
      ["env", "set"],
    ]);
    expect(convex.calls.at(-1)?.input).toMatch(
      /^AUTH_PRIVATE_KEY='[A-Za-z0-9+/]+=*'\nAUTH_JWKS='\{"keys":\[\{.+"kid":.+\}\]\}'\n$/,
    );
  });

  it("keeps an existing pair", () => {
    const convex = fakeConvex({ AUTH_PRIVATE_KEY: "configured", AUTH_JWKS: "configured" });
    expect(ensureAuthKeys(convex.run)).toBe("existing");
    expect(convex.calls).toHaveLength(2);
  });

  it.each(["AUTH_PRIVATE_KEY", "AUTH_JWKS"])("rejects %s without its partner", (name) => {
    const convex = fakeConvex({ [name]: "configured" });
    expect(() => ensureAuthKeys(convex.run)).toThrow(
      "AUTH_PRIVATE_KEY and AUTH_JWKS must be configured together.",
    );
    expect(convex.calls.every((call) => call.args[1] === "get")).toBe(true);
  });

  it.each(["AUTH_PRIVATE_KEY", "AUTH_JWKS"])("stops if reading %s fails", (name) => {
    const convex = fakeConvex({});
    expect(() =>
      ensureAuthKeys((args, input) => {
        if (args[2] === name) throw new Error("Environment read failed");
        return convex.run(args, input);
      }),
    ).toThrow("Environment read failed");
    expect(convex.calls.every((call) => call.args[1] === "get")).toBe(true);
  });

  it("reports a failed write", () => {
    expect(() =>
      ensureAuthKeys((args) => {
        if (args[1] === "set") throw new Error("Environment write failed");
        return "";
      }),
    ).toThrow("Environment write failed");
  });
});
