/**
 * Parameter encoding for the Graph API.
 *
 * Graph accepts structured parameters as JSON strings inside form/query
 * fields (e.g. `children=["1","2"]`, `trial_params={"graduation_strategy":"MANUAL"}`).
 * A few endpoints document PHP-style indexed keys instead
 * (`attached_media[0]={"media_fbid":"..."}`); those keys are listed in
 * `indexedArrays`.
 */

export type ParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ParamValue[]
  | { readonly [key: string]: ParamValue };

export type Params = Record<string, ParamValue>;

function scalar(value: ParamValue): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(dropUndefined(value));
}

function dropUndefined(value: ParamValue): ParamValue {
  if (Array.isArray(value)) return value.map(dropUndefined);
  if (value && typeof value === "object") {
    const out: Record<string, ParamValue> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = dropUndefined(v);
    return out;
  }
  return value;
}

/** Flatten params into ordered `[key, value]` pairs. */
export function encodeParamPairs(
  params: Params,
  indexedArrays: readonly string[] = [],
): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && indexedArrays.includes(key)) {
      value.forEach((item, i) => {
        const s = scalar(item);
        if (s !== undefined) pairs.push([`${key}[${i}]`, s]);
      });
      continue;
    }
    const s = scalar(value);
    if (s !== undefined) pairs.push([key, s]);
  }
  return pairs;
}

export function toSearchParams(params: Params, indexedArrays: readonly string[] = []) {
  return new URLSearchParams(encodeParamPairs(params, indexedArrays));
}
