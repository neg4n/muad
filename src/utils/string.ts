export function truncateGitHubRepositoryURL(url: string) {
  return url.replace("https://github.com/", "").replace(".git", "");
}

export function kebabToCamel(str: string) {
  return str.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

export function camelToKebab(str: string) {
  return str.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}

export function normalizeKeys<T>(obj: T): T {
  if (typeof obj !== 'object' || obj === null) return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(item => normalizeKeys(item)) as T;
  }
  
  const normalized = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = kebabToCamel(key);
    normalized[camelKey] = normalizeKeys(value);
  }
  return normalized as T;
}
