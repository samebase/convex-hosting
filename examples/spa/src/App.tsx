import { useState } from "react";
import "./App.css";

function App() {
  const [count, setCount] = useState(0);

  return (
    <main>
      <h1>Convex Hosting</h1>
      <p>The Convex deployment serves this page and its script. The counter shows that it runs.</p>
      <div className="counter">
        <button onClick={() => setCount((c) => c - 1)}>-</button>
        <span>{count}</span>
        <button onClick={() => setCount((c) => c + 1)}>+</button>
      </div>
    </main>
  );
}

export default App;
