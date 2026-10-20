import { createFileRoute, Outlet } from "@tanstack/react-router";
import {
  RedirectWithoutSession,
  redirectWithoutSession,
} from "@samebase/convex-auth-tanstack-start";

export const Route = createFileRoute("/_authed")({
  beforeLoad: ({ serverContext }) => redirectWithoutSession(serverContext, { to: "/signin" }),
  component: () => (
    <RedirectWithoutSession to="/signin">
      <Outlet />
    </RedirectWithoutSession>
  ),
});
