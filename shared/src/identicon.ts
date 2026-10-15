/** FNV-1a 32-bit hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface Identicon {
  /** 5x5 grid, horizontally mirrored; cells[row][col]. */
  cells: boolean[][];
  hue: number;
}

/** Locally generated 8-bit identicon data from an email (never Gravatar). */
export function identicon(email: string): Identicon {
  const key = email.trim().toLowerCase();
  const h1 = hashString(key);
  const h2 = hashString(`${key}#2`);
  const cells: boolean[][] = [];
  for (let row = 0; row < 5; row++) {
    const half: boolean[] = [];
    for (let col = 0; col < 3; col++) {
      const bit = row * 3 + col;
      half.push(((h1 >>> bit) & 1) === 1);
    }
    cells.push([half[0]!, half[1]!, half[2]!, half[1]!, half[0]!]);
  }
  return { cells, hue: h2 % 360 };
}
