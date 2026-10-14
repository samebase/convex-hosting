import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: About,
});

function About() {
  return (
    <main>
      <h1>About</h1>
      <p>
        Convex serves the files of this build, a deep link such as this page gets the shell from the
        single-page-application fallback, <code>_headers</code> caches the hashed files for a year,
        and <code>_redirects</code> sends <code>/home</code> to <code>/</code>. For pages rendered
        on the server, see the{" "}
        <a href="https://github.com/samebase/convex-hosting/tree/main/examples/tanstack-ssr">
          TanStack Start SSR example
        </a>
        .
      </p>
    </main>
  );
}
