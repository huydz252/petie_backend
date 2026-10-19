export function createOriginPolicy(configured: string, allowLocalhost = false) {
  const allowed = new Set(configured.split(',').map(value => value.trim()).filter(Boolean));
  return (origin: string | undefined): boolean => {
    if (!origin || allowed.has(origin)) return true;
    if (!allowLocalhost) return false;
    try {
      const url = new URL(origin);
      return url.origin === origin && ['http:', 'https:'].includes(url.protocol)
        && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    } catch { return false; }
  };
}
