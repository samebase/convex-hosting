import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { api } from "../../../convex/_generated/api.js";

export const Route = createFileRoute("/_authed/counter")({
  component: Counter,
});

function Counter() {
  // Fetched during the server render, then kept live in the browser.
  const { data: count } = useSuspenseQuery(convexQuery(api.counter.get, {}));
  const increment = useConvexMutation(api.counter.increment);
  return (
    <main>
      <h1>The counter</h1>
      <div className="counter">
        <span className="count">{count}</span>
        <button type="button" onClick={() => void increment({})}>
          Add a click
        </button>
      </div>
      <p>The count lives in Convex. Open this page in two tabs: a click in one updates both.</p>
      <p>
        <Link to="/me">Your session</Link>
      </p>
    </main>
  );
}
