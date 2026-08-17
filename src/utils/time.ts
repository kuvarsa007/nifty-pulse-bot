const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function toIST(date: Date): Date {
  return new Date(date.getTime() + IST_OFFSET_MS);
}

export function formatIST(date: Date): string {
  const ist = toIST(date);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  const h = String(ist.getUTCHours()).padStart(2, '0');
  const min = String(ist.getUTCMinutes()).padStart(2, '0');
  const s = String(ist.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s} IST`;
}

export function istDateKey(date: Date): string {
  const ist = toIST(date);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function makeIST(hour: number, minute: number, second = 0, baseDate?: Date): Date {
  const ist = toIST(baseDate ?? new Date());
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const utcMs = Date.UTC(y, m, d, hour, minute, second) - IST_OFFSET_MS;
  return new Date(utcMs);
}

export function isMarketOpen(at: Date): boolean {
  const ist = toIST(at);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;

  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const open = 9 * 60 + 15;
  const close = 15 * 60 + 30;
  return minutes >= open && minutes <= close;
}

export function isSquareOffTime(at: Date): boolean {
  const ist = toIST(at);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes >= 15 * 60 + 15;
}

export function isBuyWindowOpen(at: Date, noBuyAfterHour = 14, noBuyAfterMinute = 30): boolean {
  const ist = toIST(at);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const cutoff = noBuyAfterHour * 60 + noBuyAfterMinute;
  return minutes < cutoff;
}

export function formatBuyCutoff(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST`;
}

export function get5MinBucketKey(at: Date): string {
  const ist = toIST(at);
  const bucket = Math.floor((ist.getUTCHours() * 60 + ist.getUTCMinutes()) / 5);
  return `${istDateKey(at)}-${bucket}`;
}

export function shouldAnalyzeNow(at: Date): boolean {
  return !isSquareOffTime(at);
}

export function marketOpenTime(at: Date): Date {
  return makeIST(9, 15, 0, at);
}

export function durationText(from: Date, to: Date): string {
  const sec = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}
