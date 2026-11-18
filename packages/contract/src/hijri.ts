/*
 * Hijri (Islamic) month starts as Türkiye's Presidency of Religious Affairs (Diyanet) sets them
 * (N5). Diyanet does not wait for a sighting: since 2016 it uses the criterion of the Istanbul
 * International Hijri Calendar Union Congress —
 *
 *   a month starts on the day after the evening on which, somewhere on Earth before 24:00 UTC,
 *   the moon stands at least 5° above the horizon at sunset and at least 8° from the sun
 *   (elongation); if that happens only after 24:00 UTC, the month still starts the next day when
 *   the conjunction was before dawn in New Zealand and the criterion is met on land in the
 *   Americas.
 *
 * How it is computed here, without tables or network:
 * 1. The arithmetical (tabular) Islamic calendar says roughly when the month starts; it only
 *    picks the lunation, never the day.
 * 2. The conjunction (true new moon) of that lunation comes from Meeus, "Astronomical
 *    Algorithms", ch. 49 (a few minutes accurate for 1900–2100).
 * 3. The moon's position some hours later is extrapolated from its latitude and its speed
 *    relative to the sun at the conjunction (Meeus ch. 47, main terms); the sun's from the
 *    low-precision solar formula. That gives the elongation and, for an observer at a given
 *    latitude at sunset, the moon's (geocentric) altitude.
 * 4. The criterion: somewhere on Earth with sunset at 24:00 UTC of the conjunction's day (every
 *    latitude from 60°S to 65°N is tried at its westernmost such longitude), or — conjunction
 *    before dawn in Wellington — at sunset at one of the sample points along the Pacific coast
 *    of the Americas (Alaska to Patagonia): elongation ≥ 8° and altitude ≥ 5°.
 *
 * This reproduces every Diyanet date in the test table (test/special-days.test.ts: Ramazan and
 * Kurban Bayramı 2019–2030, Ramazan starts, kandils, Hicri yılbaşı 2023–2026). Months whose
 * crescent sits right at the 8° / 5° line can still come out one day off, so a computed date is
 * "±1 day" until it is confirmed: `DIYANET_BAYRAM_DATES` holds the announced bayram dates and
 * owners can add per-year overrides (`ReligiousDayOverride`), which win over the computation.
 */

const RAD = Math.PI / 180;
const sin = (deg: number) => Math.sin(deg * RAD);
const cos = (deg: number) => Math.cos(deg * RAD);

/** Julian day of the Unix epoch (1970-01-01 00:00 UTC). */
const UNIX_EPOCH_JD = 2440587.5;
/** ΔT (TT − UT) in days; ~69–72 s in the 2020s, irrelevant at day resolution. */
const DELTA_T_DAYS = 70 / 86_400;
const SYNODIC_MONTH = 29.530588861;
const NEW_MOON_EPOCH = 2451550.09766;

/** Julian day at 00:00 UTC of a `YYYY-MM-DD` date. */
export function julianDayOf(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / 86_400_000 + UNIX_EPOCH_JD;
}

/** `YYYY-MM-DD` (UTC) of a Julian day. */
export function isoOfJulianDay(jd: number): string {
  return new Date(Math.round((jd - UNIX_EPOCH_JD) * 86_400_000)).toISOString().slice(0, 10);
}

/** A conjunction and the moon's geometry around it. */
export interface Conjunction {
  /** Julian day (UT) of the true new moon. */
  jd: number;
  /** Moon's ecliptic latitude at the conjunction (degrees). */
  latitude: number;
  /** Rate of change of the latitude (degrees per day). */
  latitudeRate: number;
  /** Moon's speed in longitude relative to the sun (degrees per day). */
  relativeSpeed: number;
}

/** True new moon number `k` (0 = 2000-01-06), Meeus ch. 49 with the planetary corrections. */
export function newMoon(k: number): Conjunction {
  const T = k / 1236.85;
  const T2 = T * T;
  const T3 = T2 * T;
  const T4 = T3 * T;
  let jde =
    NEW_MOON_EPOCH + SYNODIC_MONTH * k + 0.00015437 * T2 - 0.00000015 * T3 + 0.00000000073 * T4;
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  const M = 2.5534 + 29.1053567 * k - 0.0000014 * T2 - 0.00000011 * T3;
  const Mp = 201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4;
  const F = 160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4;
  const O = 124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3;
  jde +=
    -0.4072 * sin(Mp) +
    0.17241 * E * sin(M) +
    0.01608 * sin(2 * Mp) +
    0.01039 * sin(2 * F) +
    0.00739 * E * sin(Mp - M) -
    0.00514 * E * sin(Mp + M) +
    0.00208 * E * E * sin(2 * M) -
    0.00111 * sin(Mp - 2 * F) -
    0.00057 * sin(Mp + 2 * F) +
    0.00056 * E * sin(2 * Mp + M) -
    0.00042 * sin(3 * Mp) +
    0.00042 * E * sin(M + 2 * F) +
    0.00038 * E * sin(M - 2 * F) -
    0.00024 * E * sin(2 * Mp - M) -
    0.00017 * sin(O) -
    0.00007 * sin(Mp + 2 * M) +
    0.00004 * sin(2 * Mp - 2 * F) +
    0.00004 * sin(3 * M) +
    0.00003 * sin(Mp + M - 2 * F) +
    0.00003 * sin(2 * Mp + 2 * F) -
    0.00003 * sin(Mp + M + 2 * F) +
    0.00003 * sin(Mp - M + 2 * F) -
    0.00002 * sin(Mp - M - 2 * F) -
    0.00002 * sin(3 * Mp + M) +
    0.00002 * sin(4 * Mp);
  const planetary: Array<[number, number]> = [
    [325, 299.77 + 0.107408 * k - 0.009173 * T2],
    [165, 251.88 + 0.016321 * k],
    [164, 251.83 + 26.651886 * k],
    [126, 349.42 + 36.412478 * k],
    [110, 84.66 + 18.206239 * k],
    [62, 141.74 + 53.303771 * k],
    [60, 207.14 + 2.453732 * k],
    [56, 154.84 + 7.30686 * k],
    [47, 34.52 + 27.261239 * k],
    [42, 207.19 + 0.121824 * k],
    [40, 291.34 + 1.844379 * k],
    [37, 161.72 + 24.198154 * k],
    [35, 239.56 + 25.513099 * k],
    [23, 331.55 + 3.592518 * k],
  ];
  for (const [coefficient, angle] of planetary) jde += coefficient * 1e-6 * sin(angle);

  // Moon's latitude near the conjunction (D ≈ 0): 5.128 sin F + the terms in M' ± F and 2D − F.
  const latitude = (5.128 - 0.173) * sin(F) + 0.281 * sin(Mp + F) + 0.278 * sin(Mp - F);
  const latitudeRate = 1.184 * cos(F);
  // d/dt of the moon's longitude minus the sun's at D = 0: mean motion + equation of the centre,
  // evection and variation (moon), equation of the centre (sun).
  const relativeSpeed = 12.4709 + 1.6856 * cos(Mp) + 0.0974 * cos(2 * Mp) - 0.0361 * cos(M);
  return { jd: jde - DELTA_T_DAYS, latitude, latitudeRate, relativeSpeed };
}

/** Geocentric moon–sun elongation (degrees) `days` after the conjunction (first order). */
export function elongationAfter(c: Conjunction, days: number): number {
  if (days <= 0) return Math.abs(c.latitude);
  const longitude = c.relativeSpeed * days;
  const latitude = c.latitude + c.latitudeRate * days;
  return Math.acos(Math.min(1, cos(longitude) * cos(latitude))) / RAD;
}

const MIN_ELONGATION = 8;
const MIN_ALTITUDE = 5;
/** The sun's centre at sunset (refraction and semi-diameter). */
const SUNSET_ALTITUDE = -0.833;

/** Sun's apparent ecliptic longitude and the obliquity at `jd` (low precision, ~0.01°). */
function sunAt(jd: number): { longitude: number; obliquity: number } {
  const n = jd - 2451545.0;
  const L = 280.46 + 0.9856474 * n;
  const g = 357.528 + 0.9856003 * n;
  return { longitude: L + 1.915 * sin(g) + 0.02 * sin(2 * g), obliquity: 23.439 - 0.0000004 * n };
}

function toEquatorial(
  longitude: number,
  latitude: number,
  obliquity: number,
): { ra: number; dec: number } {
  const dec =
    Math.asin(sin(latitude) * cos(obliquity) + cos(latitude) * sin(obliquity) * sin(longitude)) /
    RAD;
  const ra =
    Math.atan2(
      sin(longitude) * cos(obliquity) - Math.tan(latitude * RAD) * sin(obliquity),
      cos(longitude),
    ) / RAD;
  return { ra, dec };
}

/** The sun's hour angle at sunset for an observer at `latitude` (null: no sunset that day). */
function sunsetHourAngle(latitude: number, sunDec: number): number | null {
  const x = (sin(SUNSET_ALTITUDE) - sin(latitude) * sin(sunDec)) / (cos(latitude) * cos(sunDec));
  return x < -1 || x > 1 ? null : Math.acos(x) / RAD;
}

/**
 * The crescent at sunset, at time `jd`, for an observer at `latitude` who sees the sun set then:
 * geocentric elongation and the moon's geocentric altitude (degrees).
 */
function crescentAtSunset(
  c: Conjunction,
  jd: number,
  latitude: number,
): { elongation: number; altitude: number } | null {
  const sun = sunAt(jd);
  const sunEq = toEquatorial(sun.longitude, 0, sun.obliquity);
  const h0 = sunsetHourAngle(latitude, sunEq.dec);
  if (h0 === null) return null;
  const age = jd - c.jd;
  const moonEq = toEquatorial(
    sun.longitude + c.relativeSpeed * age,
    c.latitude + c.latitudeRate * age,
    sun.obliquity,
  );
  // Local sidereal time at sunset = sun's RA + its hour angle.
  const hourAngle = h0 + sunEq.ra - moonEq.ra;
  const altitude =
    Math.asin(sin(latitude) * sin(moonEq.dec) + cos(latitude) * cos(moonEq.dec) * cos(hourAngle)) /
    RAD;
  return { elongation: elongationAfter(c, age), altitude };
}

/** UT (Julian day) of sunset on the UTC day starting at `day` at a place (east longitude). */
function sunsetAt(day: number, latitude: number, longitudeEast: number): number | null {
  let t = day + 0.75 - longitudeEast / 360;
  for (let i = 0; i < 2; i++) {
    const sun = sunAt(t);
    const h0 = sunsetHourAngle(latitude, toEquatorial(sun.longitude, 0, sun.obliquity).dec);
    if (h0 === null) return null;
    t = day + 0.5 + h0 / 360 - longitudeEast / 360;
  }
  return t;
}

/** Sample points on land along the Pacific coast of the Americas (latitude, east longitude). */
const AMERICAS_COAST: ReadonlyArray<readonly [number, number]> = [
  [60, -145],
  [58, -135],
  [54, -130],
  [48, -124.5],
  [42, -124.3],
  [37, -122.4],
  [34, -118.5],
  [30, -115.8],
  [23, -110],
  [19, -105],
  [15, -92],
  [10, -85],
  [0, -80],
  [-6, -81],
  [-15, -75.5],
  [-25, -70.5],
  [-33, -71.6],
  [-40, -73.5],
  [-46, -75],
  [-53, -73],
];
const WELLINGTON = [-41.3, 174.8] as const;

const visible = (r: { elongation: number; altitude: number } | null) =>
  r !== null && r.elongation >= MIN_ELONGATION && r.altitude >= MIN_ALTITUDE;

/** Julian day (00:00 UTC) of the first day of the month this conjunction begins. */
export function monthStartAfter(c: Conjunction): number {
  const day = Math.floor(c.jd - 0.5) + 0.5; // 00:00 UTC of the conjunction's date
  const midnight = day + 1;
  // Anywhere before 24:00 UTC: at each latitude the place whose sunset is at 24:00 UTC sees the
  // oldest crescent of that evening.
  for (let latitude = -60; latitude <= 65; latitude += 2.5) {
    if (visible(crescentAtSunset(c, midnight, latitude))) return day + 1;
  }
  // The Americas rule: conjunction before dawn (sunrise − 1.5 h) in New Zealand.
  const nzSunset = sunsetAt(midnight, WELLINGTON[0], WELLINGTON[1]);
  const nzNoon = midnight + 0.5 - WELLINGTON[1] / 360;
  const nzDawn = nzSunset === null ? nzNoon - 0.3 : 2 * nzNoon - nzSunset - 1.5 / 24;
  if (c.jd < nzDawn) {
    for (const [latitude, longitude] of AMERICAS_COAST) {
      const sunset = sunsetAt(day, latitude, longitude);
      if (sunset !== null && sunset > c.jd && visible(crescentAtSunset(c, sunset, latitude))) {
        return day + 1;
      }
    }
  }
  return day + 2;
}

/** Arithmetical Islamic calendar (civil epoch), only used to find a month's lunation. */
function tabularJulianDay(year: number, month: number, day: number): number {
  return (
    day +
    Math.ceil(29.5 * (month - 1)) +
    (year - 1) * 354 +
    Math.floor((3 + 11 * year) / 30) +
    1948439.5 -
    1
  );
}

/** Hijri month key, e.g. `"1447-10"` (Şevval 1447). */
export function hijriMonthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Fixed month starts (`hijriMonthKey` → `YYYY-MM-DD`) that win over the computation. */
export type HijriMonthStarts = ReadonlyMap<string, string>;

/** Months past Zilhicce roll into the next year (month 13 = Muharrem of year + 1). */
function normalizeMonth(year: number, month: number): [number, number] {
  return [year + Math.floor((month - 1) / 12), ((((month - 1) % 12) + 12) % 12) + 1];
}

const computed = new Map<string, string>();

/** Computed (Diyanet criterion) first day of a Hijri month, as `YYYY-MM-DD` (memoised). */
export function computedHijriMonthStart(year: number, month: number): string {
  const [y, m] = normalizeMonth(year, month);
  const key = hijriMonthKey(y, m);
  const cached = computed.get(key);
  if (cached) return cached;
  const date = computeMonthStart(y, m);
  computed.set(key, date);
  return date;
}

function computeMonthStart(year: number, month: number): string {
  const approx = tabularJulianDay(year, month, 1) - 1.5;
  const k0 = Math.round((approx - NEW_MOON_EPOCH) / SYNODIC_MONTH);
  let best = newMoon(k0);
  for (const k of [k0 - 1, k0 + 1]) {
    const candidate = newMoon(k);
    if (Math.abs(candidate.jd - approx) < Math.abs(best.jd - approx)) best = candidate;
  }
  return isoOfJulianDay(monthStartAfter(best));
}

/** First day of a Hijri month: a fixed start when there is one, the computation otherwise. */
export function hijriMonthStart(
  year: number,
  month: number,
  fixed: HijriMonthStarts = new Map(),
): { date: string; fixed: boolean } {
  const [y, m] = normalizeMonth(year, month);
  const known = fixed.get(hijriMonthKey(y, m));
  if (known) return { date: known, fixed: true };
  return { date: computedHijriMonthStart(y, m), fixed: false };
}

/** `YYYY-MM-DD` of a Hijri date (day 1–30 counted from the month start). */
export function hijriToIso(
  year: number,
  month: number,
  day: number,
  fixed: HijriMonthStarts = new Map(),
): { date: string; fixed: boolean } {
  const start = hijriMonthStart(year, month, fixed);
  return { date: isoOfJulianDay(julianDayOf(start.date) + day - 1), fixed: start.fixed };
}

/** Hijri years whose months may fall between two Gregorian dates (a little wider than needed). */
export function hijriYearsBetween(from: string, to: string): number[] {
  const yearOf = (iso: string) => Math.floor((julianDayOf(iso) - 1948439.5) / 354.36707) + 1;
  const out: number[] = [];
  for (let y = yearOf(from) - 1; y <= yearOf(to) + 1; y++) out.push(y);
  return out;
}
