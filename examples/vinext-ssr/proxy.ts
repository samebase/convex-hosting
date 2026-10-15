import { convexAuthNextjsProxy } from "./auth.js";

// Refreshes the access token before a page renders, so `cookies()` in the page reads a fresh one.
export default convexAuthNextjsProxy();
