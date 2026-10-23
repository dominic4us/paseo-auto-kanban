/**
 * REQ-156: the pure rules of the new-version notice — what a version number is, which one is newer, and when the next look is
 * due. No I/O here: the server (server/update-check.ts) asks the registry and keeps the answer, the screens only draw it.
 *
 * Versions are `MAJOR.MINOR.PATCH` with an optional pre-release tail (`0.2.5-beta.1`), digits without leading zeros, each part a
 * safe integer, at most 64 characters. Build metadata (`+…`) is not accepted. Comparison is semver's: the numbers first; at the same
 * numbers a pre-release is older than the release. Two pre-releases of the same numbers are not ordered (never "newer") — the
 * notice only ever points at a release.
 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** An answer stamped more than this far in the future (the clock went back) is not shown (`resultShown`). */
export const UPDATE_CHECK_FUTURE_SLACK_MS = 5 * 60 * 1000;
/** The two lines README's "Updating" gives, shown and copied as they are — never anything the registry sent. */
export const UPDATE_COMMANDS = ['paseo plugin update paseo-auto-kanban', 'npm install -g --prefix ~/.local paseo-auto-kanban@latest'] as const;

export type Version = { major: number; minor: number; patch: number; pre: string | null };
const NUMBER = '(0|[1-9][0-9]*)', PRE = '(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?';
const SEMVER = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}${PRE}$`);

export function parseVersion(value: unknown): Version | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const match = SEMVER.exec(value);
  if (!match) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, pre: match[4] ?? null };
}
/** A release (no pre-release tail) — the only kind the registry's answer may name. */
export function parseRelease(value: unknown): string | null {
  const version = parseVersion(value);
  return version && version.pre === null ? value as string : null;
}
/** True when release `latest` is newer than `running` (either unreadable: false). */
export function isNewer(latest: unknown, running: unknown): boolean {
  const a = parseVersion(latest), b = parseVersion(running);
  if (!a || !b || a.pre !== null) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  // Same numbers: the release is newer than a pre-release of it, and not newer than itself.
  return b.pre !== null;
}
/**
 * Gate 486 F5: the registry's last good answer is shown for seven days after it came. Failing meanwhile stays silent (no notice), and
 * once the seven days are over without a good answer nothing is shown — neither "new version" nor "up to date".
 */
export const UPDATE_RESULT_KEEP_MS = 7 * UPDATE_CHECK_INTERVAL_MS;
/** Whether an answer that came at `checkedAt` (ISO) is still shown at `now` (ms): within seven days, and not from the future. */
export function resultShown(checkedAt: string | undefined, now: number): boolean {
  const at = checkedAt === undefined ? NaN : Date.parse(checkedAt);
  return Number.isFinite(at) && now - at < UPDATE_RESULT_KEEP_MS && at - now <= UPDATE_CHECK_FUTURE_SLACK_MS;
}
/**
 * Gate 486 F4: a short fingerprint of what the screens are told about new versions. The revisions an open screen polls carry it, so a
 * finished check, another device's switch or the end of the seven days reaches a quiet board on its next look. Same function on both
 * sides: the server for the reading it would send, a screen for the reading it shows. No reading (an older server): no fingerprint.
 */
export function updateCheckKey(update: { enabled: boolean; newer?: string | undefined; checkedAt?: string | undefined;
  damaged?: true | undefined } | undefined): string | undefined {
  if (!update) return undefined;
  const text = [update.enabled ? 1 : 0, update.damaged ? 1 : 0, update.newer ?? '', update.checkedAt ?? ''].join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return 'u' + hash.toString(16).padStart(8, '0');
}
/**
 * Whether a look is due at `now` (ms) after the last attempt at `last` (ISO; none or unreadable: due). Gate 490 R2: a last attempt
 * later than now means the clock went back — never due then, so going back never makes a second request within a day; once it lies
 * more than a day ahead, `restampDue` has the attempt stamped again at now (nothing asked) and the next day counts from there.
 */
export function checkDue(last: string | undefined, now: number): boolean {
  const at = last === undefined ? NaN : Date.parse(last);
  if (!Number.isFinite(at)) return true;
  return at <= now && now - at >= UPDATE_CHECK_INTERVAL_MS;
}
/** Gate 490 R2: the last attempt lies more than a day after `now` — the clock went back that far; stamp it at now, ask nothing. */
export function restampDue(last: string | undefined, now: number): boolean {
  const at = last === undefined ? NaN : Date.parse(last);
  return Number.isFinite(at) && at - now > UPDATE_CHECK_INTERVAL_MS;
}
/**
 * Gate 490: the machine's own clock since it started (on Linux the boot's id and its uptime, which a change of the date does not
 * move). Within one boot a look is due only after a day of it as well, so moving the date forward does not shorten the day either.
 * Another boot, or none known: the date alone decides.
 */
export type BootClock = { boot: string; ms: number };
export function bootDue(last: { attemptBoot?: string | undefined; attemptUptime?: number | undefined }, now: BootClock | null): boolean {
  if (!now || last.attemptBoot !== now.boot || typeof last.attemptUptime !== 'number' || !Number.isFinite(last.attemptUptime)) return true;
  return now.ms - last.attemptUptime >= UPDATE_CHECK_INTERVAL_MS;
}
