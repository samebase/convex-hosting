import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: About,
});

function About() {
  return (
    <main>
      <h1>About</h1>
      <p>
        This page is a file from the build. <code>vite.config.ts</code> has TanStack Start prerender
        it into <code>dist/client/about/index.html</code>, and <code>serveAsset</code> serves it
        like any other file: its response has an ETag and a revalidating cache header, where a
        rendered page answers <code>no-store</code>. A navigation inside the app renders it in the
        browser like any route.
      </p>
      <p>
        <Link to="/">Home</Link>
      </p>
    </main>
  );
}
