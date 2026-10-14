import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { api } from "../../convex/_generated/api.js";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const { data: count } = useSuspenseQuery(convexQuery(api.counter.get, {}));
  const increment = useConvexMutation(api.counter.increment);
  return (
    <main>
      <h1>TanStack Start SPA on Convex</h1>
      <p>
        This page is a shell that the build prerendered, filled in by the browser: the count comes
        from Convex and stays live.
      </p>
      <p>Clicks: {count}</p>
      <button type="button" onClick={() => void increment({})}>
        Add a click
      </button>
    </main>
  );
}
