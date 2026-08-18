import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import { validateConfiguredRoots } from "~/lib/safe-fs.server";
import { validateReviewRoots } from "~/lib/review.server";
import "./app.css";

/**
 * TASK-434: fail-fast root validation. Memoised inside
 * validateConfiguredRoots, so this is a no-op after the first request;
 * a misconfigured deployment dies loudly on request one with a
 * named-root error instead of a lazy per-surface 500 later.
 * (Server-only: RR7 strips loader-only imports from the client bundle,
 * the FND-02 mechanism.)
 *
 * The review panel's roots are a second, list-valued configuration that does
 * not fit safe-fs's required-single-path table, so they are vetted by their own
 * module and named here. Same purpose, same place: an instance whose review
 * roots reach into a live agent silo while sandboxed must not look healthy
 * until someone opens the panel. That check also runs on every review read of
 * its own accord, because a resource route runs its own loader and never this
 * one; this call is what makes the failure loud and early rather than a 404.
 */
export async function loader() {
  validateConfiguredRoots();
  validateReviewRoots();
  return null;
}

export const links: Route.LinksFunction = () => [
  // Inkie webfonts (League Spartan / Work Sans / Space Grotesk) are loaded via
  // the @import in app.css. These preconnects warm the font-CDN connection.
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  // TASK-470 PWA shell: manifest + home-screen icon. iOS only fires web push
  // for sites added to the Home Screen (16.4+), and that requires both.
  { rel: "manifest", href: "/manifest.webmanifest" },
  { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" },
  // TASK-472 browser-tab favicon. SVG first (crisp, modern browsers), PNGs as the
  // universal fallback. Same teal-square MC mark as the home-screen icon.
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "icon", href: "/favicon-32.png", sizes: "32x32", type: "image/png" },
  { rel: "icon", href: "/favicon-16.png", sizes: "16x16", type: "image/png" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#1a7a7a" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * Last-resort full-page boundary (2026-06-11 lifeline hardening). Content
 * routes carry their own scoped boundaries (RouteErrorPanel inside the shell),
 * so reaching THIS one means the shell/root itself failed. Show the real
 * error message even in production - MC is a tailnet-only internal tool and
 * Alex needs the actual failure text to relay, not "Oops". Always offer a
 * way out (reload / home).
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Inkie Deck hit an error";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404 - not found" : `Error ${error.status}`;
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (error && error instanceof Error) {
    details = error.message || details;
    stack = error.stack;
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-bold">{message}</h1>
      <p
        data-testid="root-error-detail"
        className="w-full overflow-x-auto rounded-md border-2 border-red-300 bg-red-50 p-3 text-left font-mono text-xs"
      >
        {details}
      </p>
      <p className="text-sm text-gray-500">
        If this persists after a reload, tell Summit or Quill - quote the message
        above.
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md border-2 border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50"
        >
          Reload
        </button>
        <a
          href="/"
          className="rounded-md border-2 border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50"
        >
          Home
        </a>
      </div>
      {stack && (
        <details className="w-full text-left">
          <summary className="cursor-pointer text-xs text-gray-500">Stack trace</summary>
          <pre className="mt-2 max-h-64 w-full overflow-auto rounded-md bg-gray-100 p-3 text-[10px] leading-tight">
            <code>{stack}</code>
          </pre>
        </details>
      )}
    </main>
  );
}
