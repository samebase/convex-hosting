import { httpRouter } from "convex/server";
import { registerSite, serveSite } from "@samebase/convex-hosting";
import { components } from "./_generated/api.js";
import { versionId } from "../.convex-hosting/version.js";

const http = httpRouter();

// Every method, every path, as a Cloudflare Worker without a script: a file for a path that has
// one, else the single-page fallback; another method than GET or HEAD on a file answers 405.
registerSite(http, serveSite(components.hosting, versionId));

export default http;
