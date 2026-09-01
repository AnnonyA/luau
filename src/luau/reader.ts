// Low-level binary reader with explicit bounds checking. Never throws raw
// RangeErrors from typed array access - every read is validated up front so
// malformed input fails with a structured error instead of an engine crash.

export class BufferOverrunError extends Error {
  constructor(where: string, offset: number, need: number, total: number) {
    super(`buffer overrun while reading ${where}: need ${need} byte(s) at offset ${offset}, but only ${total - offset} remain`);
    this.name = "BufferOverrunError";
  }
}

export class LimitExceededError extends Error {
  constructor(what: string, value: number, limit: number) {
    super(`resource limit exceeded: ${what} = ${value} > limit ${limit}`);
    this.name = "LimitExceededError";
  }
}

export class Reader {
  private view: DataView;
  private bytes: Uint8Array;
  pos = 0;

  constructor(buf: Uint8Array) {
    this.bytes = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get length(): number {
    return this.bytes.length;
  }

  remaining(): number {
    return this.bytes.length - this.pos;
  }

  private need(n: number, where: string) {
    if (this.pos + n > this.bytes.length) throw new BufferOverrunError(where, this.pos, n, this.bytes.length);
  }

  u8(where = "u8"): number {
    this.need(1, where);
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  bool(where = "bool"): boolean {
    return this.u8(where) !== 0;
  }

  u32(where = "u32"): number {
    this.need(4, where);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(where = "i32"): number {
    this.need(4, where);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(where = "f64"): number {
    this.need(8, where);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  f32(where = "f32"): number {
    this.need(4, where);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** Luau uses a standard LEB128-style unsigned varint for lengths/counts/indices. */
  varUint(where = "varUint"): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.u8(where);
      if (i === 4 && (b & 0xf0) !== 0) {
        throw new Error(`varUint at ${where} exceeded 32 bits (32-bit overflow)`);
      }
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
    throw new Error(`varUint at ${where} exceeded 5 bytes (32-bit overflow)`);
  }

  bytes_(n: number, where = "bytes"): Uint8Array {
    this.need(n, where);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Length-prefixed (varint) raw string, as used for the string table. */
  string(where = "string"): string {
    const len = this.varUint(where + ".len");
    const bytes = this.bytes_(len, where + ".data");
    return decodeUtf8(bytes);
  }

  skip(n: number) {
    this.need(n, "skip");
    this.pos += n;
  }

  atEnd(): boolean {
    return this.pos >= this.bytes.length;
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  // Luau strings are not guaranteed valid UTF-8 (could be arbitrary binary
  // used as a table key, for instance) - use a lossless fallback via latin1
  // when strict UTF-8 decoding fails, tagging nothing lost.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
}
