import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { preloadQuery } from "convex/nextjs";
import { api } from "../convex/_generated/api.js";
import { ConvexAuthNextjsServerProvider, convexAuthNextjsAccessToken, convexUrl } from "../auth.js";
import { SessionHeader } from "./session-header.js";
import "./style.css";

export const metadata: Metadata = { title: "vinext on Convex" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const token = (await convexAuthNextjsAccessToken()) ?? undefined;
  const me = await preloadQuery(api.users.me, {}, { url: convexUrl, token });
  return (
    <ConvexAuthNextjsServerProvider>
      <html lang="en">
        <body>
          <header>
            <nav>
              <Link href="/">Home</Link>
              <Link href="/about">About</Link>
              <Link href="/todos">Todos</Link>
            </nav>
            <SessionHeader preloaded={me} />
          </header>
          {children}
        </body>
      </html>
    </ConvexAuthNextjsServerProvider>
  );
}
