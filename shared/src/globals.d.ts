// TextEncoder/TextDecoder exist in both Node and browsers, but shared/ compiles
// with neither the DOM nor the Node lib, so declare the bits it uses.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input?: Uint8Array): string;
}
