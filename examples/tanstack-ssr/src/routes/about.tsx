import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  // Runs when the build prerenders this page.
  loader: () => ({ builtAt: new Date().toISOString() }),
  component: About,
});

function About() {
  const { builtAt } = Route.useLoaderData();
  return (
    <main>
      <h1>About</h1>
      <p>Built at {builtAt}</p>
      <p>
        This HTML was written at build time, and <code>serveAsset</code> serves it as a file, like
        any other file in <code>dist/client</code>.
      </p>
      <p>
        <Link to="/">Home</Link>
      </p>
    </main>
  );
}
