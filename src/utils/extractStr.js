/**
 * Extract a non-empty string from `obj` by trying each key in order.
 * If a key's value is a plain object (e.g. company: {name: "Acme"}),
 * it probes the most common sub-field names so nested schemas work too.
 */
export function extractStr(obj, ...keys) {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) return val.trim();
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = val.name || val.text || val.value || val.title || val.displayName;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
  }
  return "";
}
