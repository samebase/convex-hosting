/// <reference types="vite-plus/client" />
import { convexTest } from "convex-test";
import { anyApi, httpRouter, type FunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { api, internal } from "../component/_generated/api.js";
import type { Id } from "../component/_generated/dataModel.js";
import schema from "../component/schema.js";
import { routeAll } from "./index.js";
import { ASSETS_FORMAT, MARK_HEADER, MARK_PATH, type Assets } from "./manifest.js";

const modules = import.meta.glob(["../component/**/*.ts", "!../component/**/*.test.ts"]);
const component = { lib: { markLive: anyApi.lib.markLive } };
const DAY = 24 * 60 * 60 * 1000;

/**
 * The steps of a deploy that other deploys can come between. The mark is two: the request arrives
 * at the code that serves at that moment, and the `markLive` that this code calls runs later, when
 * other code may serve.
 */
const STEPS = ["upload", "push", "mark arrives", "mark runs"] as const;

/** A call of `markLive` that is on its way. */
type Call = { versionId: string };

/** What an upload leaves: the version file that the deploy pushes, and its stored files. */
type Uploaded = { assets: Assets; storageIds: Id<"_storage">[] };

/**
 * Every order of the steps of the deploys in `names`. An order names the deploy of each step. The
 * uploads start in the order of `names`, which only names the deploys by creation time. With
 * `atOnce`, every mark runs as it arrives, which leaves few enough orders for three deploys.
 */
function orders(names: string, atOnce: boolean, order = ""): string[] {
  if (order.length === names.length * STEPS.length) return [order];
  const done = (name: string) => order.split(name).length - 1;
  const last = order[order.length - 1];
  const next =
    atOnce && last !== undefined && done(last) === 3
      ? [last]
      : names
          .split("")
          .filter((name, i) => done(name) < STEPS.length && (i === 0 || done(names[i - 1]!) > 0));
  return next.flatMap((name) => orders(names, atOnce, order + name));
}

async function sha256Hex(body: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Run = {
  /** The deploy of each step. */
  order: string;
  /**
   * `minutes`: a second passes after every step. `days`: a day passes after every step at which no
   * deploy is between its upload and its push or has a mark on its way, the most that the
   * precondition allows, so every file and every version that never became live is old enough to
   * delete.
   */
  pace: "minutes" | "days";
  /**
   * Who marks a version live. `request` is the design: the deploy's request with its mark token,
   * answered by the code that serves. `cli` is the rejected one: the deploy's own call of
   * `markLive`.
   */
  markBy: "request" | "cli";
};

/**
 * Runs the deploys on the real component and the real serving code, over a version `p` that was
 * deployed a day before, and returns the first step after which the version that serves lacks an
 * entry or a stored file, or `null`. A stored file goes only after its entries, so the entries are
 * checked too. Every `collect` chain runs to its end before the next step.
 */
async function firstLoss({ order, pace, markBy }: Run) {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);

  /** The upload of a page that every version has, stored once, and a script of this version. */
  const upload = async (versionId: string): Promise<Uploaded> => {
    const configId = await t.run((ctx) => ctx.storage.store(new Blob(["{}"])));
    await t.action(internal.lib.createVersion, { versionId, configId });
    const entries = [];
    for (const [path, body] of [
      ["/index.html", "<h1>Home</h1>"],
      ["/assets/app.js", versionId],
    ] as const) {
      const sha256 = await sha256Hex(body);
      const [known] = await t.query(internal.lib.knownFiles, { sha256s: [sha256] });
      const storageId =
        known?.storageId ?? (await t.run((ctx) => ctx.storage.store(new Blob([body]))));
      entries.push({ path, sha256, storageId });
    }
    await t.mutation(internal.lib.recordFiles, { versionId, entries });
    await t.mutation(internal.lib.finishVersion, { versionId });
    return {
      // The mark reads the id and the token alone.
      assets: { format: ASSETS_FORMAT, versionId, markToken: `token of ${versionId}`, files: null },
      storageIds: entries.map(({ storageId }) => storageId),
    };
  };

  /** The call of `markLive` that the mark of `deploy` makes when `serving` is the code that serves. */
  const markArrives = async (deploy: Assets, serving: Assets): Promise<Call | undefined> => {
    if (markBy === "cli") return { versionId: deploy.versionId };
    let call: Call | undefined;
    const runMutation = async (_: FunctionReference<"mutation">, args: Call) => {
      call = args;
      return "marked";
    };
    const action = routeAll({ http: httpRouter(), component, assets: serving });
    const request = new Request(`https://example.convex.site${MARK_PATH}`, {
      method: "POST",
      headers: { [MARK_HEADER]: deploy.markToken },
    });
    // @ts-expect-error httpActionGeneric keeps the function as _handler; PublicHttpAction does not declare it.
    await action._handler({ runMutation }, request);
    return call;
  };

  const settle = async (pause: number) => {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.advanceTimersByTime(pause);
  };

  let serving = await upload("p");
  await t.mutation(api.lib.markLive, { versionId: "p" });
  await settle(DAY + 1);

  const deploys = new Map<string, Uploaded & { done: number; call?: Call }>();
  const steps: string[] = [];
  for (const name of order) {
    const deploy = deploys.get(name) ?? { ...(await upload(name)), done: 0 };
    deploys.set(name, deploy);
    const step = STEPS[deploy.done++]!;
    steps.push(`${step} ${name}`);
    if (step === "push") serving = deploy;
    if (step === "mark arrives") deploy.call = await markArrives(deploy.assets, serving.assets);
    if (step === "mark runs" && deploy.call !== undefined) {
      await t.mutation(api.lib.markLive, deploy.call);
    }
    const underway = [...deploys.values()].some(({ done }) => done === 1 || done === 3);
    await settle(pace === "days" && !underway ? DAY + 1 : 1000);

    const { assets, storageIds } = serving;
    const kept = await t.run(async (ctx) => {
      const entries = await ctx.db
        .query("entries")
        .withIndex("by_version_path", (q) => q.eq("versionId", assets.versionId))
        .collect();
      const files = await Promise.all(storageIds.map((id) => ctx.db.system.get("_storage", id)));
      return { entries: entries.length, files: files.filter((file) => file !== null).length };
    });
    if (kept.entries < 2 || kept.files < 2) {
      return (
        `${assets.versionId} serves with ${kept.entries} of its 2 entries and ${kept.files} of ` +
        `its 2 stored files: ${steps.join(", ")}`
      );
    }
  }
  return null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("deploys that overlap: the version that serves keeps its entries and its files", () => {
  test.each(["minutes", "days"] as const)(
    "three deploys, in every order of their steps with each mark run as it arrives, %s apart",
    async (pace) => {
      for (const order of orders("abc", true)) {
        expect(await firstLoss({ order, pace, markBy: "request" })).toBeNull();
      }
    },
  );

  test.each(["minutes", "days"] as const)(
    "two deploys, in every order of their steps, %s apart, but for the one order that is stated",
    async (pace) => {
      const losses = [];
      for (const order of orders("ab", false)) {
        const loss = await firstLoss({ order, pace, markBy: "request" });
        if (loss !== null) losses.push(loss);
      }
      // "Stated, not solved" in docs/design.md: the newer upload's mark is still on its way while
      // the older upload is pushed and marked.
      expect(losses).toEqual([
        "a serves with 0 of its 2 entries and 2 of its 2 stored files: upload a, upload b, " +
          "push b, mark arrives b, push a, mark arrives a, mark runs a, mark runs b",
      ]);
    },
  );

  test("marked from the CLI instead, a version that serves loses its entries with no mark on its way", async () => {
    // The older upload is pushed last, so a serves. Each deploy's own call marks its version, and
    // b's mark deletes a as the version that was live before it.
    const run = { order: "abbaaabb", pace: "minutes" } as const;
    expect(await firstLoss({ ...run, markBy: "cli" })).toBe(
      "a serves with 0 of its 2 entries and 2 of its 2 stored files: upload a, upload b, " +
        "push b, push a, mark arrives a, mark runs a, mark arrives b, mark runs b",
    );
    expect(await firstLoss({ ...run, markBy: "request" })).toBeNull();
  });
});
