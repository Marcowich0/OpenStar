/**
 * The join flow's entry. A Join code from the QR link fills in the code, so
 * the flow skips the number pad. A placeholder for now.
 */
export function JoinScreen({ joinCode }: { joinCode: string | undefined }) {
  return (
    <p data-testid="join-code">
      {joinCode === undefined ? "Enter the Join code" : `Join code ${joinCode}`}
    </p>
  );
}
