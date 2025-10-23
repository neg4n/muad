import { Transform } from "node:stream";

const VT_REGEX = /(?:\u001B\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\u009B[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001BP[^\u001B\u009C]*(?:\u001B\\|\u009C)|\u0090[^\u001B\u009C]*(?:\u001B\\|\u009C)|\u001B\^[^\u001B\u009C]*(?:\u001B\\|\u009C)|\u009E[^\u001B\u009C]*(?:\u001B\\|\u009C)|\u001B_[^\u001B\u009C]*(?:\u001B\\|\u009C)|\u009F[^\u001B\u009C]*(?:\u001B\\|\u009C)|[\u0080-\u009F])/gu;

export function stripVT(input: string): string {
  if (!input) return "";
  return input.replace(VT_REGEX, "");
}

export function normalizeOverstrikes(input: string): string {
  if (!input) return "";
  const out: string[] = [];
  for (const ch of input) {
    if (ch === "\b") {
      out.pop();
    } else {
      out.push(ch);
    }
  }
  const bsHandled = out.join("");
  const lines = bsHandled.split("\n").map((line) => {
    if (line.indexOf("\r") === -1) return line;
    const buf: string[] = [];
    const parts = line.split("\r");
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p] ?? "";
      const len = part.length;
      for (let i = 0; i < len; i++) {
        buf[i] = part.charAt(i);
      }
    }
    return buf.join("");
  });
  return lines.join("\n");
}

export function cleanTTY(input: string): string {
  return stripVT(normalizeOverstrikes(input));
}

export function createStripVTTransform(): Transform {
  let carry = "";
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        carry += chunk.toString("utf8");
        const parts = carry.split(/\r?\n/);
        carry = parts.pop() ?? "";
        for (const p of parts) this.push(stripVT(p) + "\n");
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb) {
      if (carry) this.push(stripVT(carry));
      cb();
    },
  });
}

export function createCleanTTYTransform(): Transform {
  let carry = "";
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        carry += chunk.toString("utf8");
        const parts = carry.split(/\r?\n/);
        carry = parts.pop() ?? "";
        for (const p of parts) this.push(cleanTTY(p) + "\n");
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb) {
      if (carry) this.push(cleanTTY(carry));
      cb();
    },
  });
}
