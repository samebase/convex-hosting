import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { useConvexAuth } from "@convex-dev/auth/nextjs";
import { useEffect } from "react";

export const Route = createFileRoute("/_authed")({
  beforeLoad: ({ serverContext }) => {
    // Only the server render has the cookie. A navigation in the browser has no `serverContext`;
    // there, the effect in the component is the gate.
    if (serverContext && serverContext.token === null) throw redirect({ to: "/signin" });
  },
  component: Authed,
});

function Authed() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const navigate = useNavigate();
  // The session ended in this tab or in another one.
  useEffect(() => {
    if (!isLoading && !isAuthenticated) void navigate({ to: "/signin" });
  }, [isLoading, isAuthenticated, navigate]);
  return <Outlet />;
}
