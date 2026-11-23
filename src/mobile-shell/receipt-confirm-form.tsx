import { useState } from "react";
import { ACTIVE_CURRENCIES } from "../foundation/currencies";
import type { ReceiptConfirmations } from "../foundation/receipt-confirmations";
import type { Receipt } from "../foundation/receipts";
import { AuthAction } from "./auth-gate";
import { ReportText } from "./period-report";
import { PlanningField } from "./planning-field";
import { confirmPendingLabel, usePendingWrite } from "./use-pending-write";

type Choice = Awaited<ReturnType<ReceiptConfirmations["loadAccounts"]>>[number];
export function ReceiptConfirmForm({ receipt, writes, done }: { receipt: Receipt; writes: ReceiptConfirmations; done: (transaction: string) => void }) {
  const [accounts, setAccounts] = useState<Choice[]>(), [account, setAccount] = useState<Choice>();
  const [amount, setAmount] = useState(""), [date, setDate] = useState(receipt.date?.value ?? ""), [description, setDescription] = useState(receipt.merchant?.value ?? "");
  const write = usePendingWrite();
  const locked = write.busy || !!write.confirm, currency = receipt.currency?.value ?? "";
  return <>
    {!accounts ? <AuthAction label="Preparar movimiento" disabled={locked} action={() => void write.run(async () => {
      setAccounts(await writes.loadAccounts());
    }, "No pudimos cargar las cuentas.")} /> : <>
      <ReportText role="header">Revisar y crear gasto</ReportText><ReportText>Comprueba el importe, la moneda y la fecha antes de confirmar.</ReportText>
      {!accounts.length && <ReportText>No hay cuentas disponibles.</ReportText>}
      {accounts.map((choice) => <AuthAction key={choice.id} label={`${choice.name} (${choice.currency})`} selected={account?.id === choice.id}
        disabled={locked} action={() => {
          if (choice.id === account?.id) return;
          if (choice.currency !== account?.currency) setAmount(ACTIVE_CURRENCIES.has(currency) && choice.currency === currency ? receipt.total?.value ?? "" : "");
          setAccount(choice);
        }} />)}
      <PlanningField label="Importe del gasto" value={amount} change={setAmount} busy={locked} />
      <PlanningField label="Fecha (AAAA-MM-DD)" value={date} change={setDate} busy={locked} />
      <PlanningField label="Descripción" value={description} change={setDescription} busy={locked} />
      <AuthAction label="Confirmar y crear gasto" disabled={locked || !account} action={() => void write.run(async (approval) => {
        const id = await writes.confirm(receipt.id, { accountId: account?.id, amount, date, description }, true, approval);
        done(id);
      }, "No pudimos crear el gasto. Actualiza el estado antes de reintentar.")} />
      {write.confirm && <AuthAction label={confirmPendingLabel} disabled={write.busy} action={write.confirm} />}
    </>}
    {write.error && <ReportText role="alert">{write.error}</ReportText>}
  </>;
}
