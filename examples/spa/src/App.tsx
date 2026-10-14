import { useState } from "react";
import "./App.css";

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Served by Convex Hosting</h1>
      <button className="count" onClick={() => setCount(count + 1)}>
        Clicked {count} times
      </button>
    </main>
  );
}
