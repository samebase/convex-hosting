"use client";

import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/nextjs";
import type { api } from "../convex/_generated/api.js";

export function SessionHeader({ preloaded }: { preloaded: Preloaded<typeof api.users.me> }) {
  const me = usePreloadedQuery(preloaded);
  const { signOut } = useAuthActions();
  if (me === null) return <Link href="/signin">Sign in</Link>;
  return (
    <>
      {`Signed in as ${me.name}`}
      <button
        type="button"
        onClick={async () => {
          await signOut();
          // A document load renders the page without the session, so /todos moves to /signin.
          location.reload();
        }}
      >
        Sign out
      </button>
    </>
  );
}
