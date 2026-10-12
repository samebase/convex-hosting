import { defineComponent } from "convex/server";
import files from "@samebase/convex-files/convex.config";

const component = defineComponent("fileOwner");
component.use(files);
export default component;
