// The seat count, for the screens that offer "Add a singer". The server's
// `SEATS` (crates/protocol/src/party.rs) is the one seat-count constant; ts-rs
// exports types, not constants, so this mirrors it and `seats.test.ts` fails
// the moment the two differ. Never write the number anywhere else.

/** How many seats a Line-up has at most. */
export const SEATS = 4;
