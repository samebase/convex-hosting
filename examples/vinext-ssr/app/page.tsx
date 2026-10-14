import Link from "next/link";
import { preloadQuery } from "convex/nextjs";
import { api } from "../convex/_generated/api.js";
import { convexUrl } from "../auth.js";
import { LatestTodos } from "./latest-todos.js";

export default async function Home() {
  const latest = await preloadQuery(api.todos.latest, {}, { url: convexUrl });
  return (
    <main>
      <h1>vinext on Convex</h1>
      <p>
        One route in <code>convex/http.ts</code> serves every page. This page is public: the server
        renders it for each request, and the list below stays live in the browser.{" "}
        <Link href="/todos">Your todos</Link> are rendered on the server as you, after you{" "}
        <Link href="/signin">sign in</Link>. The header is on every page and shows your session.
      </p>
      <h2>The latest todos of everyone</h2>
      <LatestTodos preloaded={latest} />
    </main>
  );
}
