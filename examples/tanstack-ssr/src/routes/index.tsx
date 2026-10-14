import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  // Runs on the server for the first request.
  loader: () => ({ renderedAt: new Date().toISOString().slice(11, 19) }),
  component: Home,
});

function Home() {
  const { renderedAt } = Route.useLoaderData();
  return (
    <main>
      <h1>TanStack Start on Convex</h1>
      <p>
        Rendered in a Convex HTTP action at {renderedAt} UTC. View the page source to see the HTML
        the server sent. This page is public and runs no Convex query.
      </p>
      <p>
        <Link to="/counter">The counter</Link> and <Link to="/me">your session</Link> need a
        session: the server renders them as the signed-in user. Without one, they send you to{" "}
        <Link to="/signin">sign in</Link>.
      </p>
    </main>
  );
}
