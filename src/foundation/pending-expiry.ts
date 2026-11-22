export class PendingSubmissionExpired extends Error {
  #slot: string;
  #saved: string;

  constructor(slot: string, saved: string) {
    super("Puede que este movimiento ya se haya registrado. Revisa la lista antes de volver a intentarlo.");
    this.#slot = slot;
    this.#saved = saved;
  }

  matches(slot: string, saved: string) { return this.#slot === slot && this.#saved === saved; }
}
