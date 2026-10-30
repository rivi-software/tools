/**
 * `jane@example.com`, `Jane <jane@example.com>` or `"Jane Doe" <jane@example.com>` as the address and its
 * display name, the address as written; anything else is an address alone. Each character is read a fixed number
 * of times: a regex that lets the name and the space before `<` take the same whitespace backtracks, so a name of
 * 20,000 spaces takes a second. An entry point of its own, `@rivi-software/workers-mail/address`, so a browser
 * bundle leaves the Email SDK out.
 */
export function parseMailAddress(raw: string): { email: string; name: string | null } {
  const address = raw.trim();
  // The address is the last `<…>`: a quoted display name may hold a `<` of its own.
  const open = address.lastIndexOf("<");
  if (open >= 0 && address.endsWith(">")) {
    const email = address.slice(open + 1, -1);
    let name = address.slice(0, open).trim();
    if (name.startsWith('"')) name = name.slice(1);
    if (name.endsWith('"')) name = name.slice(0, -1);
    // A quote inside the name, or a `>` inside the brackets, is not a form this reads.
    if (email && !email.includes(">") && !name.includes('"'))
      return { email: email.trim(), name: name.trim() || null };
  }
  return { email: address, name: null };
}
