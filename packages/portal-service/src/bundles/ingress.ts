export function validateBundlePath(path: string, maxBytes = 512): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("Invalid path byte limit");
  if (!path.isWellFormed() || path !== path.normalize("NFC") || new TextEncoder().encode(path).byteLength > maxBytes) {
    throw new TypeError("Invalid bundle path encoding or length");
  }
  if (/[\\%:?#\u0000-\u001f\u007f]/.test(path) || path.split("/").some(segment => !segment || segment === "." || segment === ".." || /[. ]$/.test(segment))) {
    throw new TypeError("Bundle paths must be canonical relative file paths");
  }
  return path;
}

export async function* boundedBytes(stream: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Invalid stream byte limit");
  const reader = stream.getReader();
  let complete = false;
  let consumed = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        complete = true;
        return;
      }
      consumed += result.value.byteLength;
      if (consumed > maxBytes) throw new RangeError("Stream exceeds byte limit");
      yield result.value;
    }
  } finally {
    try {
      if (!complete) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}