export function enforceSafeEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([_, value]) => Boolean(value)),
  ) as Record<string, string>;
}
