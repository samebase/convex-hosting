import { Await, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/stream")({
  loader: () => ({
    // A promise the loader does not await. A host that streams sends the page at once, with the
    // fallback below, and the value when the promise resolves; a host that buffers sends the whole
    // page when the promise has resolved. Two seconds, so the two parts are telling apart.
    later: new Promise<string>((resolve) =>
      setTimeout(() => resolve(new Date().toISOString()), 2000),
    ),
  }),
  component: Stream,
});

function Stream() {
  const { later } = Route.useLoaderData();
  return (
    <main>
      <h1>Streaming</h1>
      <p>
        The loader of this page returns a promise that resolves two seconds later, without awaiting
        it. The server sends what it has and the value when it arrives, or the whole page at the
        end, depending on the host. The value is the time the promise resolved on the server.
      </p>
      <Await promise={later} fallback={<p>Waiting for the value...</p>}>
        {(value) => <p>Resolved at {value}.</p>}
      </Await>
    </main>
  );
}
