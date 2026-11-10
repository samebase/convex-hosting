/// <reference types="vite-plus/client" />
import { convexTest } from "convex-test";
import { anyApi, httpRouter, type FunctionReference } from "convex/server";
import fc from "fast-check";
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
type Call = { versionId: string; arrivedAt: number };

/** What an upload leaves: the version file that the deploy pushes, and its stored files. */
type Uploaded = { assets: Assets; storageIds: Id<"_storage">[] };

type Run = {
  /**
   * Picks what happens next among what can happen now, or nothing to end the run: a deploy's name
   * for its next step, `cleanup N` for the next call of the Nth `collect` chain that waits, or `a
   * day passes`. A day can pass when no deploy is between its upload and its push, no mark is on
   * its way, and no `collect` waits: the day bounds how late a push may follow its upload, and the
   * rest takes seconds.
   */
  pick: (events: string[]) => string | undefined;
  /** The deploys that build the commit that serves, so their script is `p`'s, a day old. */
  rebuilds: string[];
  /**
   * Who marks a version live. `request` is the design: the deploy's request with its mark token,
   * answered by the code that serves. `cli` is the rejected one: the deploy's own call of
   * `markLive`.
   */
  markBy: "request" | "cli";
};

/**
 * Runs deploys a, b and c on the real component and the real serving code, over a version `p` that
 * was deployed a day before, and returns the first event after which the version that serves lacks
 * an entry or a stored file, or `null`. A stored file goes only after its entries, so the entries
 * are checked too.
 */
async function firstLoss({ pick, rebuilds, markBy }: Run) {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);

  /** The upload of a page that every commit has, stored once, and the commit's script. */
  const upload = async (versionId: string): Promise<Uploaded> => {
    const configId = await t.run((ctx) => ctx.storage.store(new Blob(["{}"])));
    await t.action(internal.lib.createVersion, { versionId, configId });
    const commit = rebuilds.includes(versionId) ? "p" : versionId;
    const entries = [];
    for (const [path, body] of [
      ["/index.html", "<h1>Home</h1>"],
      ["/assets/app.js", commit],
    ] as const) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
      const sha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
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
    if (markBy === "cli") return { versionId: deploy.versionId, arrivedAt: Date.now() };
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

  /**
   * The `collect` calls that wait, oldest first. The clock moves without running the timers, so
   * the scheduled calls never start by themselves: the run picks when each one does.
   */
  const waiting: { step: (typeof internal.lib.collect)["_args"]["step"] }[] = [];
  const seen = new Set<string>();
  const readScheduled = async () => {
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    for (const job of jobs) {
      if (!seen.has(job._id)) waiting.push({ step: job.args[0].step });
      seen.add(job._id);
    }
  };

  let serving = await upload("p");
  await t.mutation(api.lib.markLive, { versionId: "p", arrivedAt: Date.now() });
  for (await readScheduled(); waiting.length > 0; await readScheduled()) {
    await t.mutation(internal.lib.collect, waiting.shift()!);
  }
  vi.setSystemTime(Date.now() + DAY + 1);

  const deploys = new Map<string, Uploaded & { done: number; call?: Call }>();
  const done = (name: string) => deploys.get(name)?.done ?? 0;
  const happened: string[] = [];
  for (;;) {
    const underway = [...deploys.values()].some((deploy) => deploy.done === 1 || deploy.done === 3);
    const event = pick([
      ...["a", "b", "c"].filter((name) => done(name) < STEPS.length),
      ...waiting.map((_, i) => `cleanup ${i + 1}`),
      ...(underway || waiting.length > 0 ? [] : ["a day passes"]),
    ]);
    if (event === undefined) return null;

    if (event === "a day passes") {
      vi.setSystemTime(Date.now() + DAY);
      happened.push(event);
    } else if (event.startsWith("cleanup ")) {
      const [call] = waiting.splice(Number(event.slice("cleanup ".length)) - 1, 1);
      await t.mutation(internal.lib.collect, call!);
      happened.push(`cleanup of ${call!.step.kind}`);
    } else {
      const deploy = deploys.get(event) ?? { ...(await upload(event)), done: 0 };
      deploys.set(event, deploy);
      const step = STEPS[deploy.done++]!;
      happened.push(`${step} ${event}`);
      if (step === "push") serving = deploy;
      if (step === "mark arrives") deploy.call = await markArrives(deploy.assets, serving.assets);
      if (step === "mark runs" && deploy.call !== undefined) {
        await t.mutation(api.lib.markLive, deploy.call);
      }
    }
    await readScheduled();
    vi.setSystemTime(Date.now() + 1000);

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
        `its 2 stored files: ${happened.join(", ")}`
      );
    }
  }
}

type Orders = {
  /** The deploys that run, named in the order of their uploads. */
  deploys: string;
  /** A day passes after every event that allows one, so everything is old enough to delete. */
  days: boolean;
  /**
   * Every mark runs as it arrives and every `collect` chain runs to its end before the next step,
   * which leaves few enough orders for three deploys.
   */
  atOnce: boolean;
  markBy: Run["markBy"];
};

/**
 * Runs every order in which the deploys' steps and the calls of `collect` can happen, and returns
 * the runs that lost something, with the number of runs. It walks the tree of choices: each run
 * repeats the choices of the one before up to the deepest choice that has another option, and
 * takes that one.
 */
async function everyOrder({ deploys, days, atOnce, markBy }: Orders) {
  const losses: string[] = [];
  const path: number[] = [];
  let runs = 0;
  do {
    const sizes: number[] = [];
    const steps = new Map<string, number>();
    let rested = true;
    let last: string | undefined;
    const pick: Run["pick"] = (events) => {
      if (days && !rested && events.includes("a day passes")) {
        rested = true;
        return "a day passes";
      }
      rested = false;
      const taken = (name: string) => steps.get(name) ?? 0;
      const step = (name: string) => {
        steps.set(name, taken(name) + 1);
        last = name;
        return name;
      };
      if (atOnce && events.includes("cleanup 1")) return "cleanup 1";
      if (atOnce && last !== undefined && taken(last) === 3) return step(last);
      // The uploads start in the order of `deploys`, which only names them by creation time.
      const choices = events.filter((event) => {
        const i = deploys.indexOf(event);
        return event.startsWith("cleanup") || i === 0 || (i > 0 && taken(deploys[i - 1]!) > 0);
      });
      if (choices.length === 0) return undefined;
      const depth = sizes.push(choices.length) - 1;
      const choice = choices[(path[depth] ??= 0)]!;
      return choice.startsWith("cleanup") ? choice : step(choice);
    };
    const loss = await firstLoss({ pick, rebuilds: [], markBy });
    if (loss !== null) losses.push(loss);
    runs++;
    path.length = sizes.length;
    while (path.length > 0 && path[path.length - 1]! + 1 >= sizes[path.length - 1]!) path.pop();
    if (path.length > 0) path[path.length - 1]!++;
  } while (path.length > 0);
  return { runs, losses };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("deploys that overlap: the version that serves keeps its entries and its files", () => {
  test.each([false, true])(
    "two deploys, their steps and every call of collect in every order (a day between them: %s)",
    async (days) => {
      const orders = { deploys: "ab", days, atOnce: false, markBy: "request" } as const;
      expect(await everyOrder(orders)).toEqual({ runs: 221, losses: [] });
    },
    60_000,
  );

  test.each([false, true])(
    "three deploys, their steps in every order, each mark and collect run at once (a day between them: %s)",
    async (days) => {
      const orders = { deploys: "abc", days, atOnce: true, markBy: "request" } as const;
      expect(await everyOrder(orders)).toEqual({ runs: 280, losses: [] });
    },
    60_000,
  );

  test("three deploys, their steps and every call of collect in any order, days between them or not", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Always 40 events: enough for the three deploys and their collect calls.
        fc.array(fc.nat(), { minLength: 40, maxLength: 40 }),
        fc.subarray(["a", "b", "c"]),
        async (picks, rebuilds) => {
          let taken = 0;
          const pick: Run["pick"] = (events) =>
            taken < picks.length ? events[picks[taken++]! % events.length] : undefined;
          expect(await firstLoss({ pick, rebuilds, markBy: "request" })).toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  }, 60_000);

  test("marked from the CLI instead, a version that serves loses its entries with no mark on its way", async () => {
    const orders = { deploys: "ab", days: false, atOnce: true } as const;
    const { losses } = await everyOrder({ ...orders, markBy: "cli" });
    // The older upload is pushed last, so a serves. Each deploy's own call marks its version, and
    // b's mark deletes a as the version that was live before it.
    expect(losses).toEqual([
      "a serves with 0 of its 2 entries and 2 of its 2 stored files: upload a, upload b, " +
        "push b, push a, mark arrives a, mark runs a, cleanup of files, cleanup of versions, " +
        "mark arrives b, mark runs b, cleanup of files, cleanup of versions",
    ]);
    expect((await everyOrder({ ...orders, markBy: "request" })).losses).toEqual([]);
  });
});
