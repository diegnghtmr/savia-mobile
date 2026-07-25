import assert from "node:assert/strict";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { audit } from "./audit.mjs";

const fixture = "/tmp/opencode/savia-mobile-audit-fixture-2933";
async function copyFixture() { await rm(fixture, { force: true, recursive: true }); await cp(new URL("..", import.meta.url), fixture, { recursive: true, filter: (source) => !/[\\/](node_modules|\.tmp|\.expo|coverage)([\\/]|$)/.test(source) }); }
test.afterEach(() => rm(fixture, { force: true, recursive: true }));

test("accepts the exact clean boundary", async () => { await copyFixture(); assert.equal((await audit(fixture)).paths, 16); });
test("rejects parent metadata before mutation", async () => { await copyFixture(); await mkdir(join(fixture, ".git")); await assert.rejects(audit(fixture), /metadata/); });
test("rejects prohibited source", async () => { await copyFixture(); await writeFile(join(fixture, "src/app/index.tsx"), "fetch('https://example.invalid')\n"); await assert.rejects(audit(fixture), /prohibited/); });
test("rejects each documentation-like executable class", async (t) => { for (const path of ["requirements.txt", "CMakeLists.txt", "proof.md", "proof.mdx", "README.sh"]) await t.test(path, async () => { await copyFixture(); await writeFile(join(fixture, path), "x\n"); if (/\.(md|mdx|sh)$/.test(path)) await chmod(join(fixture, path), 0o755); await assert.rejects(audit(fixture), /inventory/); }); });
test("rejects generated binaries and oversized claims", async () => { await copyFixture(); await writeFile(join(fixture, "bundle.hbc"), "x"); await assert.rejects(audit(fixture), /inventory/); });
