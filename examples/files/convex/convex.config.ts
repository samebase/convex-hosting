import { defineApp } from "convex/server";
import fileOwner from "./components/fileOwner/convex.config.js";

const app = defineApp();
app.use(fileOwner);
export default app;
