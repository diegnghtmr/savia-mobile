import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ignored = new Set(["node_modules", ".tmp", ".expo", "coverage", ".git"]);
const sourceFile = /\.(?:[cm]?[jt]sx?|json)$/i;
const artifact = /\.(?:hbc|bin|png|jpe?g|gif|webp|aab|apk|mdx?)$|(?:^|\/)(?:requirements\.txt|CMakeLists\.txt|README\.sh)$/i;
const testFile = /(?:^|\/)(?:__tests__|__mocks__)\/|(?:^|\/)jest\.setup\.ts$|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const network = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|axios|superagent)\b/i;
const supabase = /@supabase\/[\w-]+/gi;
const plainStorage = /\b(?:async-storage|AsyncStorage|localStorage|sessionStorage|expo-file-system|react-native-fs|react-native-mmkv)\b|["'](?:node:)?fs(?:\/promises)?["']/i;
const serviceKey = /\b\w*(?:supabase\w*(?:service_?role|service_?key|secret_?key)|service_?role_?key)\w*\b|["'`]service_role["'`]/i;
const secret = /\b(?:sb_secret_[\w-]+|svt_[\w-]{16,}|eyJ[\w-]+\.[\w-]+\.[\w-]+|sk_(?:live|test)_[\w-]+)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:pass(?:word|wd)|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|authorization)["']?\s*[:=]\s*["'`][^"'`\r\n]+["'`]/i;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.filter(({ name }) => !ignored.has(name) && !/^(?:\.env(?:\.|$)|credentials\.json$)/i.test(name)).map((entry) => {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error("symbolic link rejected in app source tree");
    return entry.isDirectory() ? walk(path) : path;
  }))).flat();
}

function normalizeEscapes(text) {
  return text.replace(/\\u(?:\{([\da-f]{1,6})\}|([\da-f]{4}))|\\x([\da-f]{2})/gi, (match, braced, unicode, hex) => {
    const code = Number.parseInt(braced ?? unicode ?? hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function findInsecureUrl(path, text) {
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  function check(node) {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /http:/i.test(node.text)) {
      const parent = node.parent;
      const guarded = path === "src/foundation/config.ts" && ts.isConditionalExpression(parent) &&
        parent.whenTrue === node && parent.condition.getText(tree) === "__DEV__";
      if (!guarded || !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(node.text)) return true;
    }
    return ts.forEachChild(node, (child) => check(child) || undefined);
  }
  return check(tree);
}

export async function audit(target = root, parent = join(target, "..")) {
  await lstat(join(parent, ".git")).then(() => { throw new Error("parent repository metadata rejected"); }, (error) => {
    if (error.code !== "ENOENT") throw error;
  });
  const files = (await walk(target)).map((path) => relative(target, path).split(sep).join("/")).sort();
  if (files.some((path) => artifact.test(path))) throw new Error("generated or documentation-like executable path rejected");
  let sqlite = false;
  for (const path of files) {
    if (!sourceFile.test(path) || testFile.test(path) || path === "scripts/audit.mjs") continue;
    const source = await readFile(join(target, path), "utf8");
    const text = normalizeEscapes(source);
    const appCode = !path.endsWith(".json");
    const appDependency = path === "package.json";
    const reject = (message) => { throw new Error(`${path}: ${message}`); };
    if (serviceKey.test(text)) reject("privileged Supabase credential");
    if (secret.test(text)) reject("embedded secret");
    if ((appCode || appDependency) && (text.match(supabase) ?? []).some((name) =>
      name !== "@supabase/supabase-js" || !(appDependency || path === "src/foundation/auth.ts"),
    )) reject("Supabase outside auth");
    if ((appCode || appDependency) && path !== "src/foundation/transport.ts" && network.test(text)) reject("network outside transport");
    if (appCode && path !== "src/foundation/session-store.ts" && /expo-secure-store/i.test(text)) reject("secure storage outside session store");
    if ((appCode || appDependency) && plainStorage.test(text)) reject("unapproved persistence");
    if (/\bexpo-sqlite\b/i.test(text)) {
      if (appCode && path !== "src/foundation/offline-db.ts") reject("unapproved persistence");
      if (appDependency || appCode) sqlite = true;
    }
    if (findInsecureUrl(path, source)) reject("insecure HTTP URL");
  }
  if (sqlite) {
    const { expo } = files.includes("app.json") ? JSON.parse(await readFile(join(target, "app.json"), "utf8")) : {};
    const plugins = (expo?.plugins ?? []).filter((plugin) => plugin === "expo-sqlite" || plugin?.[0] === "expo-sqlite");
    const config = plugins[0]?.[1];
    if (plugins.length !== 1 || config?.useSQLCipher !== true || [config.android, config.ios].some((platform) =>
      platform?.useSQLCipher !== undefined && platform.useSQLCipher !== true)) throw new Error("app.json: SQLCipher plugin required");
  }
  return { paths: files.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await audit()));
