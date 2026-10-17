import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { useState } from "react";

// A server function: the browser calls it like a function, Start sends the call to the server,
// which runs the handler with the request at hand.
const greet = createServerFn({ method: "POST" })
  .validator((data: { name: string }) => data)
  .handler(
    ({ data }) =>
      `Hello, ${data.name}. The server saw your request at ${new Date().toISOString()}, from ${
        getRequestHeader("user-agent") ?? "no user agent"
      }.`,
  );

// A server function that redirects: thrown on the server, followed in the browser.
const leave = createServerFn({ method: "POST" }).handler(() => {
  throw redirect({ to: "/about" });
});

export const Route = createFileRoute("/server")({
  // A server route: a plain HTTP handler at this path, here for a form upload.
  server: {
    handlers: {
      POST: async ({ request }) => {
        // A body that is not a form throws here; so does an empty one.
        const form = await request.formData().catch(() => null);
        const file = form?.get("file");
        if (!(file instanceof File)) return new Response("A file is required.", { status: 400 });
        return Response.json({ name: file.name, type: file.type, size: file.size });
      },
    },
  },
  component: Server,
});

function Server() {
  const callGreet = useServerFn(greet);
  const callLeave = useServerFn(leave);
  const [greeting, setGreeting] = useState<string>();
  const [upload, setUpload] = useState<string>();
  return (
    <main>
      <h1>Server</h1>
      <p>
        The server function, the server route, and the request middleware of TanStack Start, on this
        host: the function answers with what the server saw, the redirecting function sends the
        browser to the About page, the form posts a file to this path's own handler, and every
        answer carries the middleware's <code>Cache-Control: no-store</code>.
      </p>
      <button
        type="button"
        onClick={async () => setGreeting(await callGreet({ data: { name: "visitor" } }))}
      >
        Call the server function
      </button>
      {greeting && <p>{greeting}</p>}
      <button type="button" onClick={() => callLeave()}>
        Call the server function that redirects
      </button>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const response = await fetch("/server", {
            method: "POST",
            body: new FormData(event.currentTarget),
          });
          setUpload(`${response.status}: ${await response.text()}`);
        }}
      >
        <input type="file" name="file" />
        <button type="submit">Upload to the server route</button>
      </form>
      {upload && <p>{upload}</p>}
    </main>
  );
}
