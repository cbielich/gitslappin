import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class JsonStore<T> {
  private file: string;

  constructor(dataDir: string, name: string, private fallback: () => T) {
    this.file = join(dataDir, name);
  }

  read(): T {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as T;
    } catch {
      return this.fallback();
    }
  }

  write(value: T): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(value, null, 2), 'utf8');
  }
}
