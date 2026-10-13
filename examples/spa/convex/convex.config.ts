import { defineApp } from "convex/server";
import hosting from "@samebase/convex-hosting/convex.config";

const app = defineApp();

app.use(hosting, { httpPrefix: "/" });

export default app;
