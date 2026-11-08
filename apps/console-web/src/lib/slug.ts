/** Lower-case, hyphen-separated version of a name, as a starting suggestion for the slug. */
export function suggestSlug(name: string): string {
  return (
    name
      .normalize('NFKD')
      // Drop combining diacritical marks left by NFKD (é -> e).
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63)
      .replace(/-+$/g, '')
  );
}
