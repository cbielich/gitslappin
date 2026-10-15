/**
 * Removes secrets from text that is about to leave the server (git output, errors, remote URLs):
 * `://user:pass@` and `://user@` become `://***@`, and Authorization / Bearer values are cut out.
 * Never throws; '' gives ''.
 */
export function scrubSecrets(text: string): string {
  try {
    return String(text)
      // Greedy to the last "@" before a "/" (a password may contain "@").
      .replace(/(:\/\/)[^\s/]*@/g, '$1***@')
      // A password that contains "/": the part after "://" has a ":" that is not a port, then a "/" and an "@" later.
      .replace(/(:\/\/)[^\s/@:]*:(?!\d+(?:\/|\s|$))[^\s/@]*\/[^\s@]*@/g, '$1***@')
      .replace(/([?&](?:token|access_token|private_token|password)=)[^&\s#]*/gi, '$1***')
      .replace(/^(.*?\bAuthorization:).*$/gim, '$1 ***')
      .replace(/\bBearer\s+\S+/gi, 'Bearer ***');
  } catch {
    return '';
  }
}
