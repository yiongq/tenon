/** The approval host: WHATWG parsing handles case, IDNs and backslashes; drop one final dot. */
export function hostOfUrl(url: string): string {
  return new URL(url).hostname.replace(/\.$/, '')
}
