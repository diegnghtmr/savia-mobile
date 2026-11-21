import { fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import * as SecureStore from "expo-secure-store";
import { createIdentity } from "../src/foundation/identity";
import { createTransport } from "../src/foundation/transport";
import { AuthGate } from "../src/mobile-shell/auth-gate";

jest.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn() }));

const profile = "00000000-0000-4000-8000-000000000010";
const first = { id: "00000000-0000-4000-8000-000000000001", name: "Casa" };
const second = { id: "00000000-0000-4000-8000-000000000002", name: "Viajes" };
const page = (items = [first, second], cursor?: string) => ({ items, pageInfo: { hasNextPage: cursor !== undefined, nextCursor: cursor ?? null } });
const reply = (json: unknown, status = 200) => ({ status, ok: status >= 200 && status < 300, redirected: false, headers: new Headers(), json: async () => json });
const store = jest.mocked(SecureStore);
const draft = { email: "fixture@example.invalid", displayName: " Ada ", locale: "es-co", countryCode: "co", timezone: "America/Bogota", dateFormat: "DD/MM/YYYY", weekStartsOn: "1", numberFormat: "1.234,56", defaultCurrency: "cop", workspaceName: " Casa ", baseCurrency: "cop" };
const key = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

beforeEach(() => { jest.resetAllMocks(); store.getItemAsync.mockResolvedValue(null); });
function setup() {
  const read = jest.fn().mockResolvedValue({ accessToken: "access-fixture" });
  const send = jest.fn(async (url: string, _init: RequestInit) => url.endsWith("/me") ? reply({ id: profile }) : reply(page()));
  const api = createTransport({ baseUrl: "https://api.invalid", send, sessions: { read } });
  const newKey = jest.fn().mockReturnValueOnce(key(3)).mockReturnValueOnce(key(4));
  return { api, read, send, newKey, identity: createIdentity(api.withSession, newKey) };
}
const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

test("rejects malformed onboarding, recovery and ambiguous selection before touching any state", async () => {
  const { identity, read, send, newKey } = setup();
  for (const bad of [{ email: "not-an-email" }, { weekStartsOn: "" }, { displayName: "a".repeat(121) }, { timezone: "Bad/Zone" }, { baseCurrency: "ZZZ" }, { locale: "no!" }, { countryCode: "ZZ" }, { numberFormat: "bad" }, { dateFormat: ["DD/MM/YYYY"] }, { subject: profile }]) {
    await expect(identity.onboard({ ...draft, ...bad })).rejects.toThrow("Revisa los datos de tu perfil.");
  }
  for (const bad of [{ name: ["Casa", "Casa"], baseCurrency: "COP" }, { name: "Casa", baseCurrency: "X" }, { name: " ", baseCurrency: "USD" }]) {
    await expect(identity.recovery()(bad)).rejects.toThrow("Revisa el nombre y la moneda base del espacio.");
  }
  await expect(identity.select([first.id, first.id])).rejects.toThrow("Este espacio ya no está disponible.");
  expect(read).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(newKey).not.toHaveBeenCalled();
  expect(store.getItemAsync).not.toHaveBeenCalled(); expect(store.setItemAsync).not.toHaveBeenCalled(); expect(store.deleteItemAsync).not.toHaveBeenCalled();
});

test.each([200, 201])("submits normalized onboarding with no client subject and confirms returned workspace (%s)", async (status) => {
  const { identity, send } = setup();
  send.mockResolvedValueOnce(reply({ profileId: profile, workspaceId: first.id }, status));
  await expect(identity.onboard(draft)).resolves.toMatchObject({ active: first });
  expect(send.mock.calls.map(([url]) => url)).toEqual(["https://api.invalid/v1/onboarding", "https://api.invalid/v1/me", "https://api.invalid/v1/workspaces"]);
  expect(send.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ ...draft, email: draft.email, displayName: "Ada", locale: "es-CO", countryCode: "CO", weekStartsOn: 1, defaultCurrency: "COP", workspaceName: "Casa", baseCurrency: "COP" }) });
  expect(store.setItemAsync).toHaveBeenCalledWith(expect.stringContaining(profile), first.id, { keychainAccessible: 1 });
});

test("restores from paginated membership and independently denies a revoked scope before adding its header", async () => {
  const { identity, api, read, send } = setup();
  store.getItemAsync.mockResolvedValue(second.id);
  send.mockResolvedValueOnce(reply({ id: profile })).mockResolvedValueOnce(reply(page([first], "x/y?"))).mockResolvedValueOnce(reply(page([second])));
  await expect(identity.bootstrap()).resolves.toMatchObject({ active: second, items: [first, second] });
  expect(send.mock.calls[2][0]).toBe("https://api.invalid/v1/workspaces?cursor=x%2Fy%3F");
  await expect(api.requestInWorkspace(second.id, "/v1/accounts")).resolves.toEqual(page());
  expect(header(send.mock.calls.at(-1)![1], "X-Workspace-Id")).toBe(second.id);
  expect(send.mock.calls.slice(0, -1).every(([, init]) => header(init, "X-Workspace-Id") === null)).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
  send.mockResolvedValueOnce(reply({ id: profile })).mockResolvedValueOnce(reply(page([first])));
  await expect(api.requestInWorkspace(second.id, "/v1/accounts")).rejects.toThrow("Este espacio ya no está disponible.");
  expect(send.mock.calls.filter(([url]) => url.endsWith("/accounts"))).toHaveLength(1);
  expect(store.setItemAsync).not.toHaveBeenCalled();
});

test("requires fresh unique membership for selection and does not write for missing or duplicated IDs", async () => {
  const { identity, send } = setup();
  await expect(identity.select(key(9))).rejects.toThrow("Este espacio ya no está disponible.");
  send.mockResolvedValueOnce(reply({ id: profile })).mockResolvedValueOnce(reply(page([first, first])));
  await expect(identity.select(first.id)).rejects.toThrow();
  expect(store.setItemAsync).not.toHaveBeenCalled();
  await expect(identity.select(second.id)).resolves.toMatchObject({ active: second });
  expect(store.setItemAsync).toHaveBeenCalledTimes(1);
  expect(store.setItemAsync).toHaveBeenCalledWith(expect.stringContaining(profile), second.id, { keychainAccessible: 1 });
});

test("zero-workspace recovery reuses the key for the same normalized draft and rotates it for edited intent", async () => {
  const { identity, send, newKey } = setup();
  let created = false;
  send.mockImplementation(async (url, init) => {
    if (url.endsWith("/me")) return reply({ id: profile });
    if (init.method === "POST") return created ? reply(first, 201) : reply({}, 503);
    return reply(page(created ? [first] : []));
  });
  const recover = identity.recovery();
  await expect(recover({ name: " Casa ", baseCurrency: "cop" })).rejects.toThrow();
  await expect(recover({ name: "Casa", baseCurrency: "COP" })).rejects.toThrow();
  expect(store.setItemAsync).not.toHaveBeenCalled();
  send.mockImplementationOnce(async () => reply({ id: profile })).mockImplementationOnce(async () => reply(page([])));
  created = true;
  await expect(recover({ name: "Casa familiar", baseCurrency: "COP" })).resolves.toMatchObject({ active: first });
  expect(send.mock.calls.filter(([, init]) => init.method === "POST").map(([, init]) => header(init, "Idempotency-Key"))).toEqual([key(3), key(3), key(4)]);
  expect(newKey).toHaveBeenCalledTimes(2);
  expect(store.setItemAsync).toHaveBeenCalledTimes(1);
});

test("renders the onboarding form and rejects incomplete submission without a new session read", async () => {
  const { identity, read, send } = setup();
  send.mockResolvedValueOnce(reply({}, 404));
  await render(<AuthGate auth={() => { throw new Error("unexpected auth"); }} identity={identity} home={<Text>Resumen protegido</Text>} />);
  await fireEvent.press(await screen.findByRole("button", { name: "Completar configuración" }));
  expect(await screen.findByText("Revisa los datos de tu perfil.")).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
  expect(store.setItemAsync).not.toHaveBeenCalled();
});
