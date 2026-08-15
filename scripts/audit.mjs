import { access, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
export const expected = [".github/workflows/ci.yml",".gitignore","mise.toml","package.json","pnpm-workspace.yaml","pnpm-lock.yaml","app.json","tsconfig.json","jest.config.cjs","jest.setup.ts","src/app/_layout.tsx","src/app/index.tsx","src/app/+not-found.tsx","src/mobile-shell/tokens.ts","__tests__/shell.test.tsx","scripts/audit.mjs","scripts/audit.test.mjs"].sort();
const prohibited = /\b(fetch|XMLHttpRequest|WebSocket|Supabase|SQLite|AsyncStorage|localStorage|https?:\/\/|\/v1\/|auth|outbox)\b/i;
const generated = /\.(hbc|bin|png|jpg|jpeg|gif|webp|aab|apk)$/i;
const docsLike = /(^|\/)(requirements\.txt|CMakeLists\.txt|README\.sh)$|\.(md|mdx)$/i;

async function walk(dir) { return (await Promise.all((await readdir(dir, { withFileTypes: true })).filter((entry) => !["node_modules", ".tmp", ".expo", "coverage", ".git"].includes(entry.name)).map(async (entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : join(dir, entry.name)))).flat(); }

// The boundary is the workspace directory above this module, not this module.
// Every child of the polyrepo is a repository of its own, so rejecting `.git`
// in `target` rejected the very layout ADR-0017 authorized — and did it before
// any other check could run, which left this audit unable to pass anywhere it
// was actually installed. What must never become a repository is the parent
// that holds the children side by side.
export async function audit(target = root, parent = join(target, "..")) {
  await access(join(parent, ".git")).then(() => { throw new Error("parent repository metadata rejected"); }, () => undefined);
  const files = (await walk(target)).map((path) => relative(target, path)).sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error(`path inventory mismatch: ${files.join(",")}`);
  if (files.some((path) => generated.test(path) || docsLike.test(path))) throw new Error("generated or documentation-like executable path rejected");
  const source = (await Promise.all(files.filter((path) => /\.(tsx?|mjs|cjs)$/.test(path) && path !== "scripts/audit.mjs" && path !== "scripts/audit.test.mjs" && path !== "__tests__/shell.test.tsx" && path !== "jest.setup.ts").map((path) => readFile(join(target, path), "utf8")))).join("\n");
  if (prohibited.test(source)) throw new Error(`prohibited source: ${source.match(prohibited)?.[0]}`);
  const authored = (await Promise.all(files.filter((path) => path !== "pnpm-lock.yaml").map(async (path) => (await readFile(join(target, path), "utf8")).split("\n").filter(Boolean).length))).reduce((a, b) => a + b, 0);
  if (authored > 400) throw new Error(`authored line budget exceeded: ${authored}`);
  return { authored, paths: files.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await audit()));
