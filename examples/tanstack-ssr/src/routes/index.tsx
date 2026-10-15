import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { convexQuery } from "@convex-dev/react-query";
import { api } from "../../convex/_generated/api.js";

export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(convexQuery(api.todos.latest, {}));
  },
  component: Home,
});

function Home() {
  const { data: todos } = useSuspenseQuery(convexQuery(api.todos.latest, {}));
  return (
    <main>
      <h1>TanStack Start on Convex</h1>
      <p>
        The server renders the pages with your session. This page is public: the server renders it
        for each request, and the list below stays live in the browser.{" "}
        <Link to="/about">About</Link> was rendered at build time and is served as a file.{" "}
        <Link to="/todos">Your todos</Link> are rendered on the server as you, after you{" "}
        <Link to="/signin">sign in</Link>. The header is on every page and shows your session.
      </p>
      <h2>The latest todos of everyone</h2>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            {todo.author}: {todo.done ? <s>{todo.text}</s> : todo.text}
          </li>
        ))}
      </ul>
    </main>
  );
}
