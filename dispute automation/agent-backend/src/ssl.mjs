/**
 * Makes the certificate check explicit. pg already treats 'require' as 'verify-full' today, and its next major
 * version will not, so state the strict mode instead of relying on the alias. Local databases are left alone.
 */
export function withSslMode(url) {
  try {
    const u = new URL(url);
    if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)) return url;
    const mode = u.searchParams.get('sslmode');
    if (!mode || ['require', 'prefer', 'verify-ca'].includes(mode)) u.searchParams.set('sslmode', 'verify-full');
    return u.toString();
  } catch {
    return url;
  }
}
