import { fireEvent, render, screen } from "@testing-library/react-native";
import type { Outbox } from "../src/foundation/outbox";
import { OutboxPanel } from "../src/mobile-shell/outbox-panel";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("expo-secure-store", () => ({}));

test("outbox surfaces expiry and conflicts and only confirms or discards the selected entry explicitly", async () => {
  const box: Outbox = { request: jest.fn(), subscribe: () => () => {}, sync: jest.fn().mockResolvedValue(undefined), discard: jest.fn().mockResolvedValue(undefined), list: jest.fn().mockResolvedValue([
    { id: 1, path: "/v1/transactions", issue: "expired", queued_at: 0 }, { id: 2, path: "/v1/transfers", issue: "409", queued_at: 0 },
  ]) };
  await render(<OutboxPanel box={box} />);
  const press = async (name: string) => fireEvent.press(await screen.findByRole("button", { name }));
  await press("Operaciones pendientes (2)");
  expect(screen.getByText("Puede que este movimiento ya se haya registrado. Revisa la lista antes de volver a intentarlo.")).toBeTruthy();
  expect(screen.getByText("Conflicto (409). Revisa la lista y los datos de la operación.")).toBeTruthy();
  expect(box.sync).not.toHaveBeenCalledWith(1);
  await press("Registrar de todos modos"); expect(box.sync).toHaveBeenCalledWith(1);
  await press("Descartar transferencia"); expect(box.discard).not.toHaveBeenCalled();
  await press("Confirmar descarte"); expect(box.discard).toHaveBeenCalledWith(2);
});
