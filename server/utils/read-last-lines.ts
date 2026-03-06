import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

const CHUNK_SIZE = 64 * 1024;
const DEFAULT_MAX_BYTES = 512 * 1024;

export function readLastLines(filePath: string, maxLines: number, maxBytes = DEFAULT_MAX_BYTES): string {
  if (maxLines <= 0 || maxBytes <= 0 || !existsSync(filePath)) {
    return "";
  }

  const { size } = statSync(filePath);
  if (size === 0) {
    return "";
  }

  const fd = openSync(filePath, "r");
  const chunks: Buffer[] = [];
  let position = size;
  let bytesLoaded = 0;
  let newlineCount = 0;

  try {
    while (position > 0 && bytesLoaded < maxBytes && newlineCount <= maxLines) {
      const length = Math.min(CHUNK_SIZE, position, maxBytes - bytesLoaded);
      const start = position - length;
      const chunk = Buffer.alloc(length);
      const bytesRead = readSync(fd, chunk, 0, length, start);
      if (bytesRead <= 0) {
        break;
      }

      const slice = bytesRead === length ? chunk : chunk.subarray(0, bytesRead);
      chunks.unshift(slice);
      bytesLoaded += bytesRead;
      newlineCount += countNewlines(slice);
      position = start;
    }
  } finally {
    closeSync(fd);
  }

  const text = Buffer.concat(chunks).toString("utf-8");
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!normalized) {
    return "";
  }

  const lines = normalized.split("\n");
  return lines.length <= maxLines ? normalized : lines.slice(-maxLines).join("\n");
}

function countNewlines(chunk: Buffer): number {
  let count = 0;
  for (const byte of chunk) {
    if (byte === 10) {
      count++;
    }
  }
  return count;
}
