import { defineApp } from "convex/server";
import convexHosting from "@samebase/convex-hosting/convex.config";

const app = defineApp({ httpPrefix: "/api" });

app.use(convexHosting, { httpPrefix: "/" });

export default app;
