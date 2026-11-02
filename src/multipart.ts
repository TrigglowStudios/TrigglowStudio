/** Pure: a multipart/form-data body, so uploads don't depend on FormData support. A file-backed `data` Blob streams from disk. */
export function buildMultipart(boundary: string, fields: Record<string, string>, file: { name: string; type: string; data: Blob }): Blob {
  const parts: (string | Blob)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`);
  parts.push(file.data, `\r\n--${boundary}--\r\n`);
  return new Blob(parts);
}
