import { act, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { createIdentity } from "../src/foundation/identity";
import { createOffline } from "../src/foundation/offline-cache";
import { createTransport } from "../src/foundation/transport";
import { OfflineBanner } from "../src/mobile-shell/offline-banner";

jest.mock("expo-sqlite");
jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: require("node:crypto").randomUUID, getRandomBytesAsync: async (size: number) => require("node:crypto").randomBytes(size) }));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
const native = jest.requireMock("expo-sqlite");
const saved = new Map<string, string>();
const profile = "00000000-0000-4000-8000-000000000010", otherProfile = "00000000-0000-4000-8000-000000000011";
const first = { id: "00000000-0000-4000-8000-000000000020", name: "Casa" };
const second = { id: "00000000-0000-4000-8000-000000000021", name: "Trabajo" };
const accounts = "/v1/accounts?limit=20", movements = "/v1/transactions?limit=20", tags = "/v1/tags?limit=200";
const debts = "/v1/debts?limit=20", projection = `/v1/debts/${first.id}/projection`;
const summary = "/v1/analytics/summary?from=2026-11-01&to=2026-11-21";
const cashFlow = "/v1/analytics/cash-flow?from=2026-11-01&to=2026-11-21";
const monthly = "/v1/analytics/advanced?from=2026-11-01&to=2026-11-21&metric=monthly_savings_capacity";
const calendar = "/v1/analytics/advanced?from=2026-11-21&to=2026-12-21&metric=financial_calendar";
const subscriptions = "/v1/subscriptions?limit=5&status=detected";
const recent = [accounts, movements, tags, "/v1/budgets?limit=20", `/v1/budgets/${first.id}`, "/v1/funds?limit=20", "/v1/funds?limit=20&cursor=fixture",
  debts, projection, summary, cashFlow, monthly, calendar, subscriptions];

function setup() {
  let online = true, denied = false, workspaces = [first, second], owner = profile;
  const principal = jest.fn(async () => owner);
  const send = jest.fn(async (url: string, init: RequestInit) => {
    if (!online) throw new Error("offline");
    const path = url.slice("https://api.invalid".length), headers = init.headers as Record<string, string>;
    if (path === "/v1/me") return Response.json({ id: owner });
    if (path === "/v1/workspaces") return Response.json({ items: workspaces, pageInfo: { hasNextPage: false } });
    return Response.json({ path, workspace: headers["X-Workspace-Id"] }, { status: denied ? 403 : 200 });
  });
  const api = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read: async () => ({ accessToken: "fixture" }) } });
  const reopen = () => createOffline(createIdentity(api.withSession), principal);
  return { reopen, send, api, setOwner: (id: string) => { owner = id; }, setOnline: (value: boolean) => { online = value; },
    denyReads: () => { denied = true; }, removeFirst: () => { workspaces = [second]; }, rejoinFirst: () => { workspaces = [first, second]; } };
}

beforeEach(() => {
  jest.clearAllMocks(); native.resetSQLite(); saved.clear();
  jest.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => saved.get(key) ?? null);
  jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => { saved.set(key, value); });
  jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => { saved.delete(key); });
});

test("cold offline restart reads only saved accounts, movements, budgets, funds, debts, projections, reports and catalogs and presents their saved date", async () => {
  const fx = setup(), local = fx.reopen();
  await local.identity.select(first.id);
  const show = jest.fn();
  const scoped = local.scope(profile, first.id, fx.api.requestInWorkspace, show);
  await Promise.all(recent.map((path) => scoped(first.id, path)));
  expect(show).not.toHaveBeenCalled();
  expect([...saved.values()].filter((value) => /^[a-f0-9]{64}$/.test(value))).toHaveLength(1);
  fx.setOnline(false); fx.send.mockClear();
  const restarted = fx.reopen();
  await expect(restarted.identity.bootstrap()).resolves.toMatchObject({ active: first });
  function Screen() {
    const [date, setDate] = useState<number | null>(null), [paths, setPaths] = useState<string[]>([]);
    useEffect(() => {
      const request = restarted.scope(profile, first.id, fx.api.requestInWorkspace, setDate);
      void Promise.all(recent.map((path) => request(first.id, path)))
        .then((rows) => setPaths(rows.map((row) => (row as { path: string }).path)), () => setPaths(["No guardado"]));
    }, []);
    return <><OfflineBanner savedAt={date} />{paths.map((path) => <Text key={path}>{path}</Text>)}</>;
  }
  await render(<Screen />);
  await act(async () => {});
  expect(await screen.findByRole("alert", { name: /Sin conexión — datos guardados el .+/ })).toBeTruthy();
  for (const path of recent) expect(screen.getByText(path)).toBeTruthy();
  expect(fx.send.mock.calls.every(([url]) => url.endsWith("/v1/me"))).toBe(true);
  expect([...saved.values()].filter((value) => /^[a-f0-9]{64}$/.test(value))).toHaveLength(1);
});

test("cache never crosses workspace or signed-in profile and never replaces a permission error", async () => {
  const fx = setup(), local = fx.reopen(), stale = jest.fn();
  await local.identity.select(first.id);
  const read = local.scope(profile, first.id, fx.api.requestInWorkspace, stale);
  const paths = [accounts, debts, projection, summary, cashFlow, monthly, calendar, subscriptions];
  for (const path of paths) await read(first.id, path);
  fx.denyReads();
  for (const path of paths) await expect(read(first.id, path)).rejects.toMatchObject({ status: 403 });
  await local.identity.select(second.id);
  fx.setOnline(false);
  const other = local.scope(profile, second.id, fx.api.requestInWorkspace, stale);
  for (const path of paths) await expect(other(second.id, path)).rejects.toThrow();
  fx.setOwner(otherProfile);
  await expect(fx.reopen().identity.bootstrap()).rejects.toThrow();
  for (const path of paths) await expect(read(first.id, path)).rejects.toThrow();
  expect(stale).not.toHaveBeenCalled();
});

test("verified removal and sign-out wipe the corresponding reads, even after rejoining", async () => {
  const fx = setup(), local = fx.reopen(), stale = jest.fn();
  await local.identity.select(first.id);
  const read = local.scope(profile, first.id, fx.api.requestInWorkspace, stale);
  await read(first.id, accounts);
  fx.removeFirst();
  await expect(read(first.id, accounts)).rejects.toThrow("Este espacio ya no está disponible.");
  fx.rejoinFirst(); await local.identity.select(first.id); fx.setOnline(false);
  await expect(read(first.id, accounts)).rejects.toThrow();
  fx.setOnline(true); await local.identity.select(second.id);
  const secondRead = local.scope(profile, second.id, fx.api.requestInWorkspace, stale);
  await secondRead(second.id, accounts);
  fx.setOnline(false);
  await expect(read(first.id, accounts)).rejects.toThrow();
  await expect(secondRead(second.id, accounts)).resolves.toMatchObject({ workspace: second.id });
  await local.signOut(async () => {});
  const restarted = fx.reopen();
  await expect(restarted.identity.bootstrap()).rejects.toThrow();
  await expect(secondRead(second.id, accounts)).rejects.toThrow();
  expect(stale).toHaveBeenCalledTimes(1);
});

test("without native SQLCipher online reads work but offline storage fails closed", async () => {
  native.disableCipher();
  const fx = setup(), local = fx.reopen(), stale = jest.fn();
  await local.identity.select(first.id);
  const read = local.scope(profile, first.id, fx.api.requestInWorkspace, stale);
  await expect(read(first.id, accounts)).resolves.toMatchObject({ workspace: first.id });
  expect(native.openDatabaseAsync).toHaveBeenCalled();
  fx.setOnline(false);
  await expect(read(first.id, accounts)).rejects.toThrow();
  expect(stale).not.toHaveBeenCalled();
});

// Reviewer regression (verify mwr70vb0). Append to __tests__/offline-cache.test.tsx.
import { offlineStore } from "../src/foundation/offline-db";

test("verified removal cannot fall back to revoked data when SQLite refuses the purge", async () => {
  const fx = setup(), local = fx.reopen();
  await local.identity.select(first.id);
  const read = local.scope(profile, first.id, fx.api.requestInWorkspace, jest.fn());
  await expect(read(first.id, accounts)).resolves.toMatchObject({ workspace: first.id });
  await offlineStore()(db => db.execAsync(
    "CREATE TRIGGER fail_cache_delete BEFORE DELETE ON cache BEGIN SELECT RAISE(ABORT,'write failed'); END",
  ));
  fx.removeFirst();
  await expect(read(first.id, accounts)).rejects.toThrow("Este espacio ya no está disponible.");
  fx.setOnline(false);
  const restarted = fx.reopen();
  await expect(restarted.scope(profile, first.id, fx.api.requestInWorkspace, jest.fn())(first.id, accounts)).rejects.toThrow();
  await expect(restarted.identity.bootstrap()).rejects.toThrow();
});

// Reviewer regression (verify mwr87e91). Append to __tests__/offline-cache.test.tsx.
test("a failed purge in a revoked workspace does not block fresh reads in a still-authorized workspace", async () => {
  const f = setup(), offline = f.reopen();
  await offline.identity.select(first.id);
  const home = offline.scope(profile, first.id, f.api.requestInWorkspace, jest.fn());
  await home(first.id, accounts);

  await offline.identity.select(second.id);
  const work = offline.scope(profile, second.id, f.api.requestInWorkspace, jest.fn());
  await offlineStore()(db => db.execAsync(`CREATE TRIGGER reject_home_purge BEFORE DELETE ON cache
    WHEN OLD.workspace = '${first.id}' BEGIN SELECT RAISE(ABORT, 'purge failed'); END`));

  f.removeFirst();
  f.send.mockClear();
  await expect(work(second.id, accounts)).resolves.toEqual({ path: accounts, workspace: second.id });
  expect(f.send.mock.calls.map(([url]) => url.replace("https://api.invalid", ""))).toEqual([
    "/v1/me", "/v1/workspaces", accounts,
  ]);
});

// Reviewer regression (verify mwraeren). Append to __tests__/offline-cache.test.tsx.
function deferred<T>() {
  let release!: (value: T) => void;
  const result = new Promise<T>((resolve) => { release = resolve; });
  return { result, release };
}

test("older in-flight membership and account responses cannot restore a verified revoked workspace", async () => {
  const f = setup(), x = f.reopen();
  await x.identity.select(first.id);
  const read = x.scope(profile, first.id, f.api.requestInWorkspace, jest.fn());
  await read(first.id, accounts);

  const normal = f.send.getMockImplementation()!;
  const accountSeen = deferred<void>(), membershipSeen = deferred<void>();
  const releaseAccount = deferred<void>(), releaseMembership = deferred<void>();
  let holdAccount = true, holdMembership = false;
  f.send.mockImplementation(async (url, init) => {
    const path = new URL(url).pathname, captured = await normal(url, init);
    if (path === "/v1/accounts" && holdAccount) {
      holdAccount = false;
      accountSeen.release();
      await releaseAccount.result;
    } else if (path === "/v1/workspaces" && holdMembership) {
      holdMembership = false;
      membershipSeen.release();
      await releaseMembership.result;
    }
    return captured;
  });

  const oldData = read(first.id, accounts).catch(() => null);
  await accountSeen.result;
  holdMembership = true;
  const oldMembership = read(first.id, accounts).catch(() => null);
  await membershipSeen.result;

  f.removeFirst();
  await expect(read(first.id, accounts)).rejects.toThrow("Este espacio ya no está disponible.");
  f.denyReads();
  releaseMembership.release();
  await oldMembership;
  releaseAccount.release();
  await oldData;

  f.setOnline(false);
  const reopened = f.reopen();
  await expect(
    reopened.scope(profile, first.id, f.api.requestInWorkspace, jest.fn())(first.id, accounts),
  ).rejects.toThrow();
});

test("a reopened scope cannot accept old data after a genuine regrant", async () => {
  const f = setup(), x = f.reopen();
  await x.identity.select(first.id);
  const normal = f.send.getMockImplementation()!, seen = deferred<void>(), release = deferred<void>();
  f.send.mockImplementation(async (url, init) => {
    const result = await normal(url, init);
    if (new URL(url).pathname === "/v1/accounts") { seen.release(); await release.result; }
    return result;
  });
  const stale = x.scope(profile, first.id, f.api.requestInWorkspace, jest.fn())(first.id, accounts).catch((error) => error);
  await seen.result;
  const other = f.reopen();
  try {
    f.removeFirst();
    await expect(other.identity.bootstrap()).resolves.toMatchObject({ active: null });
    f.rejoinFirst();
    await expect(other.identity.select(first.id)).resolves.toMatchObject({ active: first });
  } finally { release.release(); }
  expect(await stale).toMatchObject({ message: "Este espacio ya no está disponible." });
  f.setOnline(false);
  await expect(other.scope(profile, first.id, f.api.requestInWorkspace, jest.fn())(first.id, accounts)).rejects.toThrow();
});
