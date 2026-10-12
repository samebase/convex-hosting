import { defineComponent } from "convex/server";
import files from "@samebase/convex-hosting/files/convex.config";

const hosting = defineComponent("hosting");
hosting.use(files);
export default hosting;
