// Shared helper for the checkout / success / cancel pages.
window.GW = {
  // Builds the "return to merchant" link. For registered merchants the link may only point to their own
  // registered website (allowedHost), so a tampered redirectUrl can never send people to another site.
  redirectTarget: function (redirectUrl, orderId, status, allowedHost) {
    if (!redirectUrl) return null;
    try {
      var u = new URL(redirectUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      if (allowedHost) {
        var h = u.hostname.replace(/^www\./, '');
        if (h !== allowedHost && !h.endsWith('.' + allowedHost)) return null;
      }
      u.searchParams.set('orderId', orderId);
      u.searchParams.set('status', status);
      return u.toString();
    } catch (e) { return null; }
  }
};
