// Responses that carry account, session or contact data must never be stored
// by browsers, proxies or CDNs (shared computers, back/forward cache).
const noStore = (req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  return next();
};

export default noStore;
