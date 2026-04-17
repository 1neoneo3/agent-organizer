import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import express from "express";
import { mountStatic } from "../static-handlers.js";

describe("static cache headers", () => {
  let server: Server;
  let baseUrl = "";
  let distDir = "";

  before(async () => {
    distDir = mkdtempSync(join(tmpdir(), "ao-static-test-"));
    mkdirSync(join(distDir, "assets"), { recursive: true });
    writeFileSync(
      join(distDir, "index.html"),
      "<!doctype html><html><body>test</body></html>",
    );
    writeFileSync(
      join(distDir, "assets", "index-abc123.js"),
      "/* hashed bundle */",
    );

    const app = express();
    mountStatic(app, distDir);

    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    rmSync(distDir, { recursive: true, force: true });
  });

  it("returns Cache-Control: no-cache on GET /", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-cache");
  });

  it("returns long-lived immutable Cache-Control for hashed assets", async () => {
    const res = await fetch(`${baseUrl}/assets/index-abc123.js`);
    assert.equal(res.status, 200);
    const cacheControl = res.headers.get("cache-control") ?? "";
    assert.ok(
      cacheControl.includes("public"),
      `expected "public" directive, got: ${cacheControl}`,
    );
    assert.ok(
      cacheControl.includes("max-age=31536000"),
      `expected "max-age=31536000", got: ${cacheControl}`,
    );
    assert.ok(
      cacheControl.includes("immutable"),
      `expected "immutable" directive, got: ${cacheControl}`,
    );
  });

  it("returns Cache-Control: no-cache on SPA deep-link fallback", async () => {
    const res = await fetch(`${baseUrl}/tasks/123`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-cache");
  });
});
