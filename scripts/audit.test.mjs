import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { audit } from "./audit.mjs";

async function fixture(t, files = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "savia-mobile-audit-"));
  t.after(() => rm(workspace, { force: true, recursive: true }));
  const app = join(workspace, "mobile");
  await mkdir(join(app, ".git"), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    const destination = join(app, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, text);
  }
  return app;
}

test("accepts a growing app with network and Secure Store only at their boundaries", async (t) => {
  const app = await fixture(t, {
    "package.json": '{"dependencies":{"@supabase/supabase-js":"2.110.9"}}',
    "src/foundation/auth.ts": 'import { createClient } from "@supabase/supabase-js";',
    "src/foundation/transport.ts": 'import { fetch } from "expo/fetch";\n',
    "src/foundation/session-store.ts": 'import * as Store from "expo-secure-store";\n',
    "src/foundation/config.ts": 'const dev = __DEV__ ? "http://127.0.0.1:8080" : "https://api.invalid";\n',
    "src/app/example.tsx": "export const value = true;\n".repeat(401),
  });
  assert.deepEqual(await audit(app), { paths: 6 });
});

test("allows SQLite only behind its cipher adapter and the SQLCipher plugin", async (t) => {
  const app = await fixture(t, {
    "package.json": '{"dependencies":{"expo-sqlite":"~57.0.5"}}',
    "app.json": '{"expo":{"plugins":[["expo-sqlite",{"useSQLCipher":true}]]}}',
    "src/foundation/offline-db.ts": 'import { openDatabaseAsync } from "expo-sqlite";',
  });
  await assert.doesNotReject(audit(app));
  await writeFile(join(app, "app.json"), '{"expo":{"plugins":[["expo-sqlite",{"useSQLCipher":true,"ios":{"useSQLCipher":false}}]]}}');
  await assert.rejects(audit(app), /SQLCipher plugin required/);
});

const pickerPaths = ["src/mobile-shell/image-picker-source.ts", "src/mobile-shell/document-picker-source.ts"];
const cleanup = `import type * as PickerCache from "expo-file-system";
function releasePickerCopy({ uri, file }: PickerAsset) {
  if (file || !uri.startsWith("file:///")) return;
  const { File, Paths } = require("expo-file-system") as typeof PickerCache;
  if (isPickerCopy(uri, Paths.cache.uri)) new File(uri).delete();
}`;
for (const path of pickerPaths) test(`allows only temporary-file cleanup in ${path}`, async (t) => {
  const app = await fixture(t, { [path]: cleanup });
  await assert.doesNotReject(audit(app));
  for (const source of [
    `${cleanup}\nlocalStorage.setItem("x", "y");`,
    cleanup.replace("new File(uri).delete()", 'new File(uri).write("fixture")'),
    cleanup.replace("new File(uri).delete()", "new File(uri).copy(File)"),
    cleanup.replace("new File(uri).delete()", "new File(uri).move(File)"),
    cleanup.replace("new File(uri).delete()", "new File(uri).create()"),
    cleanup.replace("new File(uri).delete()", "new File(Paths.cache.uri).delete()"),
    cleanup.replace("new File(uri).delete()", "new File(uri).delete(); new File(uri).create()"),
  ]) {
    await writeFile(join(app, path), source);
    await assert.rejects(audit(app), { message: `${path}: unapproved persistence` });
  }
});

test("audits the checked-out repository without an exact inventory", async () => {
  await assert.doesNotReject(audit());
});

test("rejects a repository at the workspace boundary, not the child boundary", async (t) => {
  const app = await fixture(t);
  await mkdir(join(app, "..", ".git"));
  await assert.rejects(audit(app), /parent repository metadata rejected/);
});

for (const [name, path, body, message] of [
  ["global network", "src/app/index.tsx", 'globalThis["fetch"]("https://api.invalid");', "network outside transport"],
  ["other network client", "client.js", 'import axios from "axios";', "network outside transport"],
  ["Supabase outside auth", "src/foundation/transport.ts", 'import { createClient } from "@supabase/supabase-js";', "Supabase outside auth"],
  ["a separate Supabase SDK package in auth", "src/foundation/auth.ts", 'import { RealtimeClient } from "@supabase/realtime-js";', "Supabase outside auth"],
  ["auth with raw networking", "src/foundation/auth.ts", 'fetch("https://example.invalid");', "network outside transport"],
  ["service key in auth", "src/foundation/auth.ts", 'const key = process.env.EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;', "privileged Supabase credential"],
  ["direct Secure Store", "src/app/index.tsx", 'import * as Store from "expo-secure-store";', "secure storage outside session store"],
  ["plain persistence", "src/foundation/session-store.ts", 'import Store from "@react-native-async-storage/async-storage";', "unapproved persistence"],
  ["plain files", "src/foundation/session-store.ts", 'import { File } from "expo-file-system";', "unapproved persistence"],
  ["SQLite outside cipher adapter", "src/app/index.tsx", 'import { openDatabaseAsync } from "expo-sqlite";', "unapproved persistence"],
  ["service key reference", "src/foundation/transport.ts", 'const key = process.env.EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;', "privileged Supabase credential"],
  ["secret literal", "src/foundation/transport.ts", 'const key = "sb_secret_fixture_not_a_real_key";', "embedded secret"],
  ["hardcoded password", "app.json", '{"password":"synthetic-fixture-value"}', "embedded secret"],
  ["insecure origin", "src/foundation/config.ts", 'const base = "http://api.invalid";', "insecure HTTP URL"],
  ["loopback outside dev config", "src/app/index.tsx", 'const base = "http://localhost:3000";', "insecure HTTP URL"],
]) {
  test(`rejects ${name}`, async (t) => {
    const app = await fixture(t, { [path]: body });
    await assert.rejects(audit(app), { message: `${path}: ${message}` });
  });
}

for (const [name, path, source, reason] of [
  ["escaped network name", "src/app/example.ts",
    String.raw`globalThis["f\u0065tch"]("https://fixture.invalid");`,
    "network outside transport"],
  ["escaped privileged key", "src/app/example.ts",
    String.raw`const key = "sb_\u0073ecret_synthetic_fixture";`,
    "embedded secret"],
  ["privileged role literal", "src/app/example.ts",
    'const role = "service_role";',
    "privileged Supabase credential"],
  ["split insecure URL", "src/app/example.ts",
    'const url = "http:" + "//fixture.invalid";',
    "insecure HTTP URL"],
  ["escaped storage name", "src/app/example.ts",
    String.raw`globalThis["local\u0053torage"].setItem("test", "synthetic");`,
    "unapproved persistence"],
  ["non-test script network call", "scripts/runtime.mjs",
    'fetch("https://fixture.invalid");',
    "network outside transport"],
]) {
  test(`rejects ${name}`, async (t) => {
    const app = await fixture(t, { [path]: source });
    await assert.rejects(audit(app), { message: `${path}: ${reason}` });
  });
}

for (const path of ["requirements.txt", "CMakeLists.txt", "proof.md", "proof.mdx", "README.sh", "bundle.hbc"]) {
  test(`rejects unrelated scaffold artifacts: ${path}`, async (t) => {
    const app = await fixture(t, { [path]: "fixture\n" });
    await assert.rejects(audit(app), /generated or documentation-like executable path rejected/);
  });
}

// Reviewer regression (verify mwstw4vi). Append to scripts/audit.test.mjs.
test("receipt picker audit exception does not allow writing image bytes", async (t) => {
  const path = "src/mobile-shell/image-picker-source.ts";
  const app = await fixture(t, {
    [path]: 'const { File, Paths } = require("expo-file-system");\n' +
      'new File(Paths.cache, "receipt.png").write("image bytes");',
  });
  await assert.rejects(audit(app), { message: `${path}: unapproved persistence` });
});
