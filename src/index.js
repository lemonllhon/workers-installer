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

async function sha256Hex(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
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

      const sourceAsset = await env.ASSETS.fetch(new Request(new URL("/agent/index.js", request.url), request));
      if (!sourceAsset.ok) {
        return json({ error: "agent_not_found" }, 500);
      }
      const sourceSha256 = await sha256Hex(await sourceAsset.arrayBuffer());

      const sourceBaseUrl = `${url.origin}/agent`;
      const installerText = (await asset.text()).replaceAll(
        "__WORKER_SOURCE_BASE_URL__",
        sourceBaseUrl
      ).replaceAll("__WORKER_SOURCE_SHA256__", sourceSha256);
      const headers = new Headers(asset.headers);
      headers.set("content-type", "text/x-shellscript; charset=utf-8");
      headers.set("cache-control", "no-store, max-age=0");
      headers.set("content-disposition", "inline; filename=install.sh");
      return new Response(installerText, { status: asset.status, headers });
    }

    return env.ASSETS.fetch(request);
  }
};
