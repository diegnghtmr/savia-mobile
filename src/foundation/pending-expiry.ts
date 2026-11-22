const replayLimit = 23 * 60 * 60 * 1000; // Leave an hour before the server forgets the key.

export function isReplayFresh(createdAt: number | null, serverDate: number | null) {
  return createdAt !== null && serverDate !== null && serverDate >= createdAt && serverDate - createdAt < replayLimit;
}

export const pendingWarning = "Puede que este movimiento ya se haya registrado. Revisa la lista antes de volver a intentarlo.";

export class PendingSubmissionExpired extends Error {
  #slot: string;
  #saved: string;

  constructor(slot: string, saved: string) {
    super(pendingWarning);
    this.#slot = slot;
    this.#saved = saved;
  }

  matches(slot: string, saved: string) { return this.#slot === slot && this.#saved === saved; }
}

export class OutboxQueued extends Error {
  constructor(issue: string | null) {
    super(issue === "expired" ? pendingWarning : issue ? "La operación necesita revisión. Revisa las operaciones pendientes."
      : "Guardado sin conexión. Revisa las operaciones pendientes.");
  }
}
