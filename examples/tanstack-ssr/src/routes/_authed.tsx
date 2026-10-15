import { createFileRoute, Outlet } from "@tanstack/react-router";
import {
  RedirectWithoutSession,
  redirectWithoutSession,
} from "@samebase/convex-hosting-tanstack-start/convex-auth";

export const Route = createFileRoute("/_authed")({
  beforeLoad: ({ serverContext }) => redirectWithoutSession(serverContext, { to: "/signin" }),
  component: () => (
    <RedirectWithoutSession to="/signin">
      <Outlet />
    </RedirectWithoutSession>
  ),
});
