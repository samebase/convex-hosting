import { httpRouter } from "convex/server";
import { routeAll } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { site } from "../.convex-hosting/version.js";

const http = httpRouter();

// Every method, every path, as a Cloudflare Worker without a script: a file for a path that has
// one, else the single-page fallback; another method than GET or HEAD on a file answers 405.
routeAll(http, components.hosting, site);

export default http;
