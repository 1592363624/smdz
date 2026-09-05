export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export function beijingNow(): Date {
  return new Date(Date.now() + BEIJING_OFFSET_MS);
}

export function shiftDatesInPlace(value: unknown, offsetMs: number): void {
  if (value instanceof Date) {
    value.setTime(value.getTime() + offsetMs);
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  const seen = new WeakSet<object>();
  const walk = (v: unknown): void => {
    if (v instanceof Date) {
      v.setTime(v.getTime() + offsetMs);
      return;
    }
    if (!v || typeof v !== 'object') {
      return;
    }
    if (seen.has(v)) {
      return;
    }
    seen.add(v);
    for (const key of Object.keys(v)) {
      walk((v as Record<string, unknown>)[key]);
    }
  };
  walk(value);
}