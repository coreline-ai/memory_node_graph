export const normalizeMarkdown = (value: string) =>
  value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").normalize("NFC");

export const normalizeFileName = (value: string) =>
  value
    .normalize("NFC")
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();

export const stableKey = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}
