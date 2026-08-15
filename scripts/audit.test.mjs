import assert from "node:assert/strict";
import { access, chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { audit } from "./audit.mjs";

let workspace;

// The copy keeps `.git`. This module lives in a repository of its own — the
// polyrepo layout puts one at every child — and the boundary the audit
// protects is the workspace directory above it, which must never become one.
async function copyFixture() {
  workspace = await mkdtemp(join(tmpdir(), "savia-mobile-audit-"));
  const fixture = join(workspace, "savia-mobile");
  await cp(new URL("..", import.meta.url), fixture, {
    recursive: true,
    filter: (source) =>
      !/[\\/](node_modules|\.tmp|\.expo|coverage)([\\/]|$)/.test(source),
  });
  return fixture;
}

test.afterEach(() => rm(workspace, { force: true, recursive: true }));

test("accepts the exact clean boundary", async () => {
  const fixture = await copyFixture();
  assert.equal((await audit(fixture)).paths, 16);
});

test("accepts the repository this module is itself kept in", async () => {
  const fixture = await copyFixture();
  await access(join(fixture, ".git"));
  await assert.doesNotReject(audit(fixture));
});

test("rejects a repository at the workspace boundary", async () => {
  const fixture = await copyFixture();
  await mkdir(join(workspace, ".git"));
  await assert.rejects(audit(fixture), /metadata/);
});

test("rejects prohibited source", async () => {
  const fixture = await copyFixture();
  await writeFile(
    join(fixture, "src/app/index.tsx"),
    "fetch('https://example.invalid')\n",
  );
  await assert.rejects(audit(fixture), /prohibited/);
});

test("rejects each documentation-like executable class", async (t) => {
  for (const path of [
    "requirements.txt",
    "CMakeLists.txt",
    "proof.md",
    "proof.mdx",
    "README.sh",
  ])
    await t.test(path, async () => {
      const fixture = await copyFixture();
      await writeFile(join(fixture, path), "x\n");
      if (/\.(md|mdx|sh)$/.test(path)) await chmod(join(fixture, path), 0o755);
      await assert.rejects(audit(fixture), /inventory/);
    });
});

test("rejects generated binaries and oversized claims", async () => {
  const fixture = await copyFixture();
  await writeFile(join(fixture, "bundle.hbc"), "x");
  await assert.rejects(audit(fixture), /inventory/);
});
