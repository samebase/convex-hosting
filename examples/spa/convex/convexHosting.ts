import { components } from "./_generated/api.js";
import { exposeDeploymentQuery } from "@samebase/convex-hosting";

// Public query for live-reload notifications. Only needed if you use
// <UpdateBanner /> / useDeploymentUpdates from @samebase/convex-hosting/react.
export const { getCurrentDeployment } = exposeDeploymentQuery(components.convexHosting);
