import { defineApp } from "convex/server";
import hosting from "@samebase/convex-hosting/convex.config";

const app = defineApp({ httpPrefix: "/api" });

app.use(hosting, { httpPrefix: "/" });

export default app;
