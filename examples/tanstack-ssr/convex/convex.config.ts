import { defineApp } from "convex/server";
import convexHosting from "@samebase/convex-hosting/convex.config";

const app = defineApp();
app.use(convexHosting);
export default app;
