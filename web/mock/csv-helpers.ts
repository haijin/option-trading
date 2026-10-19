/** Null when every required column is present, otherwise a sentence naming the missing ones. */
export function csvHeaderError(header: string[], required: string[], expected = required.join(',')): string | null {
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length === 0) return null;
  return `missing column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. Expected the header: ${expected}`;
}

/** Keep error and warning lists readable: the first `max` lines and a count of the rest. */
export function firstErrors(list: string[], max = 20): string[] {
  return list.length > max ? [...list.slice(0, max), `... and ${list.length - max} more`] : list;
}
