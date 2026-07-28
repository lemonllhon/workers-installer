const INSTALL_PATH = "/install.sh";
const INSTALL_ALIASES = new Set([INSTALL_PATH, "/inatall.sh"]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return json({ ok: true, service: "nodejs-argo-installer" });
    }

    if (INSTALL_ALIASES.has(url.pathname)) {
      if (request.method !== "GET") {
        return json({ error: "method_not_allowed" }, 405);
      }

      const assetRequest = new Request(new URL(INSTALL_PATH, request.url), request);
      const asset = await env.ASSETS.fetch(assetRequest);
      if (!asset.ok) {
        return json({ error: "installer_not_found" }, 404);
      }

      const sourceBaseUrl = `${url.origin}/agent`;
      const installerText = (await asset.text()).replaceAll(
        "__WORKER_SOURCE_BASE_URL__",
        sourceBaseUrl
      );
      const headers = new Headers(asset.headers);
      headers.set("content-type", "text/x-shellscript; charset=utf-8");
      headers.set("cache-control", "no-store, max-age=0");
      headers.set("content-disposition", "inline; filename=install.sh");
      return new Response(installerText, { status: asset.status, headers });
    }

    return env.ASSETS.fetch(request);
  }
};
