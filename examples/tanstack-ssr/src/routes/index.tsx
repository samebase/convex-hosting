import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { convexQuery } from "@convex-dev/react-query";
import { api } from "../../convex/_generated/api.js";

export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(convexQuery(api.todos.count, {}));
  },
  component: Home,
});

function Home() {
  const { data: count } = useSuspenseQuery(convexQuery(api.todos.count, {}));
  return (
    <main>
      <h1>TanStack Start on Convex</h1>
      <p>{count} todos so far</p>
      <p>
        One route in <code>convex/http.ts</code> serves every page. This page is public: the server
        renders it for each request, and the count stays live in the browser.{" "}
        {/* A full page load gets the prerendered file; a client navigation would run its loader. */}
        <Link to="/about" reloadDocument>
          About
        </Link>{" "}
        was rendered at build time and is served as a file. <Link to="/todos">Your todos</Link> are
        rendered on the server as you, after you <Link to="/signin">sign in</Link>. The header is on
        every page and shows your session.
      </p>
    </main>
  );
}
