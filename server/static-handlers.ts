import { resolve } from "node:path";
import express, { type Application } from "express";

// Mount static file serving + SPA fallback with cache headers tuned for hashed
// Vite bundles. The layout of `distPath` is the standard Vite output:
//
//   dist/
//     index.html            <- entry HTML referencing /assets/<name>-<hash>.js|css
//     assets/
//       index-<hash>.js
//       index-<hash>.css
//       ...
//
// Hashed files under /assets are safe to cache forever because every rebuild
// produces new hashed filenames. index.html (and any SPA deep-link that falls
// back to it) must be revalidated on every load, otherwise a browser can hold
// onto an old index.html that references bundle hashes that no longer exist on
// disk and end up rendering a white screen.
export function mountStatic(app: Application, distPath: string): void {
  // Long-lived immutable cache for hashed bundles
  app.use(
    "/assets",
    express.static(resolve(distPath, "assets"), {
      immutable: true,
      maxAge: "1y",
    }),
  );

  // Other static files (favicon, robots.txt, etc.) — but not index.html, which
  // we serve explicitly below so the SPA fallback and the root path share the
  // same no-cache policy.
  app.use(express.static(distPath, { index: false }));

  app.get("/{*splat}", (_req, res) => {
    res.set("Cache-Control", "no-cache");
    res.sendFile(resolve(distPath, "index.html"));
  });
}
