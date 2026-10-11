// Synthetic fixture.
const DEFAULTS: Record<string, { requests: number; windowMs: number }> = {
  alfa: { requests: 40, windowMs: 60_000 },
};

export function getProviderDefaultRateLimit(provider: string) {
  return DEFAULTS[provider];
}
