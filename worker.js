// Redirect legacy workers.dev links to the canonical domain; serve assets otherwise.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname.endsWith(".workers.dev")) {
      url.hostname = "chronotope.acxx.art";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
