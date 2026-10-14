import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useState } from "react";
import { api } from "../../../convex/_generated/api.js";

export const Route = createFileRoute("/_authed/todos")({
  // On the server, the query runs with the token of the session cookie.
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(convexQuery(api.todos.list, {}));
  },
  component: Todos,
});

function Todos() {
  const { data: todos } = useSuspenseQuery(convexQuery(api.todos.list, {}));
  const add = useConvexMutation(api.todos.add);
  const [text, setText] = useState("");
  return (
    <main>
      <h1>Your todos</h1>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>{todo.text}</li>
        ))}
      </ul>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          await add({ text });
          setText("");
        }}
      >
        <input
          aria-label="New todo"
          required
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit">Add</button>
      </form>
    </main>
  );
}
