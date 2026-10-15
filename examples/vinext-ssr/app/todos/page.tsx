import { redirect } from "next/navigation";
import { preloadQuery } from "convex/nextjs";
import { api } from "../../convex/_generated/api.js";
import { convexAuthNextjsAccessToken, convexUrl, isAuthenticatedNextjs } from "../../auth.js";
import { TodoList } from "./todo-list.js";

export default async function Todos() {
  if (!(await isAuthenticatedNextjs())) redirect("/signin");
  const token = (await convexAuthNextjsAccessToken()) ?? undefined;
  const todos = await preloadQuery(api.todos.list, {}, { url: convexUrl, token });
  return (
    <main>
      <h1>Your todos</h1>
      <TodoList preloaded={todos} />
    </main>
  );
}
