import { httpRouter } from "convex/server";
import { routeAll } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { assets } from "../.convex-hosting/version.js";
// Type only, nothing is bundled: the server build imported below.
import type {} from "@samebase/convex-hosting-tanstack-start/server-build";
import server from "../dist/server/server.js";

const http = httpRouter();

// Every method, every path: a file for a path that has one (another method than GET or HEAD on it
// answers 405), the app's server (src/server.ts) for every other path, as a Cloudflare Worker with
// static assets does. The /auth routes are the app's server's too: Convex Auth serves no HTTP routes.
routeAll({ http, component: components.hosting, assets, worker: server });

export default http;
