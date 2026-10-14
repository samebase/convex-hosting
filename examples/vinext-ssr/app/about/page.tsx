export default function About() {
  return (
    <main>
      <h1>About</h1>
      <p>
        This example renders vinext's App Router in a Convex HTTP action:{" "}
        <code>convex/http.ts</code> serves the build's files with <code>serveSite</code> and renders
        every other request with vinext's server build. Convex Auth's Next.js integration owns the
        session cookies. This page is rendered for each request, like the others.
      </p>
    </main>
  );
}
