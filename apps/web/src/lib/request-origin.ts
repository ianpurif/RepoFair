const localOrigins = new Set(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']);

function cleanConfiguredOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password && !url.search && !url.hash
      && !/[*,]/.test(url.hostname) && (url.protocol === 'https:' || localOrigins.has(value));
  } catch { return false; }
}

/** APP_ORIGIN is the sole browser authority. Host/forwarded headers never grant an origin. */
export function isAllowedRequestOrigin(request: Request, configuredOrigin: string | undefined): boolean {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return false;
  let actual: URL;
  try { actual = new URL(request.url); } catch { return false; }
  if (actual.protocol !== 'http:' && actual.protocol !== 'https:') return false;
  if (configuredOrigin === undefined) return origin === actual.origin;
  // Invalid explicit configuration must deny even otherwise-valid local requests.
  if (!cleanConfiguredOrigin(configuredOrigin)) return false;
  if (origin === configuredOrigin && !localOrigins.has(configuredOrigin)) return true;
  return localOrigins.has(actual.origin) && origin === actual.origin;
}
