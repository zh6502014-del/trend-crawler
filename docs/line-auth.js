/* A short-lived LINE login token is exchanged only in the browser.
   Never persist, print or send it to the static site server. */
(function (root) {
  'use strict';
  function read(location, history) {
    const url = new URL(location.href);
    const hash = new URLSearchParams(url.hash.slice(1));
    const token = hash.get('line_token');
    const authError = hash.has('error') || hash.has('error_code');
    if (token === null && !authError) return null;
    const valid = token !== null && /^[A-Za-z0-9_-]{20,256}$/.test(token) && hash.get('type') === 'email';
    for (const key of ['line_token','type','error','error_code','error_description']) hash.delete(key);
    url.hash = hash.toString();
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    return valid ? { token } : { expired: true };
  }
  async function signIn(auth, entry) {
    let failed = false;
    if (entry.token) {
      try {
        const { data, error } = await auth.verifyOtp({ token_hash: entry.token, type: 'email' });
        if (!error && data?.session) return { ok: true };
        failed = !!error && !/expired|invalid|otp/i.test(error.message || '');
      } catch { failed = true; }
    }
    // A previously used link must not disrupt a still-valid local login.
    try {
      const { data } = await auth.getSession();
      if (data?.session) return { ok: true };
    } catch { failed = true; }
    return { ok: false, reason: failed ? 'unavailable' : 'expired' };
  }
  const api = { read, signIn };
  root.LineAuth = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
