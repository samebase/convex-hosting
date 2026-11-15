import { createFileRoute } from "@tanstack/react-router";
import { DEFAULT_MIN_PASSWORD_LENGTH } from "@convex-dev/auth/methods/username-password";
import {
  useSignInWithUsernamePassword,
  useSignUpWithUsernamePassword,
} from "@convex-dev/auth/methods/username-password/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api.js";

export const Route = createFileRoute("/signin")({
  component: SignIn,
});

function SignIn() {
  const { signIn } = useSignInWithUsernamePassword(api.auth);
  const { signUp } = useSignUpWithUsernamePassword(api.auth);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <main>
      <h1>Sign in</h1>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const credentials = { username, password };
          const submitter =
            event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
          const result =
            submitter?.id === "signup" ? await signUp(credentials) : await signIn(credentials);
          if (result.status === "error") {
            setError(result.userError.error);
            return;
          }
          // A document load, like sign-out: the server renders /todos as the user from the new
          // cookie. The provider confirms the session after this resolves, so a navigation inside
          // the app could reach the gate first and bounce back here.
          location.assign("/todos");
        }}
      >
        <input
          name="username"
          placeholder="Username"
          autoComplete="username"
          required
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <input
          name="password"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          minLength={DEFAULT_MIN_PASSWORD_LENGTH}
          required
        />
        <button type="submit">Sign in</button>
        <button type="submit" id="signup">
          Sign up
        </button>
      </form>
      {error !== null && <p role="alert">{`Failed: ${error}`}</p>}
    </main>
  );
}
