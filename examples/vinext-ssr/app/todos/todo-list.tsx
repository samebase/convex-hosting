"use client";

import { useMutation, usePreloadedQuery, type Preloaded } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api.js";

export function TodoList({ preloaded }: { preloaded: Preloaded<typeof api.todos.list> }) {
  const todos = usePreloadedQuery(preloaded);
  const add = useMutation(api.todos.add);
  const toggle = useMutation(api.todos.toggle);
  const [text, setText] = useState("");
  return (
    <>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <label>
              <input
                type="checkbox"
                checked={todo.done}
                onChange={() => void toggle({ id: todo.id })}
              />{" "}
              {todo.done ? <s>{todo.text}</s> : todo.text}
            </label>
          </li>
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
          maxLength={280}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit">Add</button>
      </form>
    </>
  );
}
