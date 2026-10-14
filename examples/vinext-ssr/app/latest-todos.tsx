"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";
import type { api } from "../convex/_generated/api.js";

export function LatestTodos({ preloaded }: { preloaded: Preloaded<typeof api.todos.latest> }) {
  const todos = usePreloadedQuery(preloaded);
  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>
          {todo.author}: {todo.done ? <s>{todo.text}</s> : todo.text}
        </li>
      ))}
    </ul>
  );
}
