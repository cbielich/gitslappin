import { readOpState } from './opState';

export interface GuardReply {
  code: 409;
  body: { error: string; opInProgress: true };
}

/**
 * A stopped merge, rebase, cherry-pick or revert blocks branch changes. Returns the 409 reply to send, or null when
 * the repo is free. `opInProgress` tells the client this is not the `exists` conflict of a checkout.
 */
export async function guardOp(root: string): Promise<GuardReply | null> {
  return (await readOpState(root)) ? { code: 409, body: { error: 'Another operation is in progress.', opInProgress: true } } : null;
}
