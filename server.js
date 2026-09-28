// MMN OTT MART relay — talks to the IPTV provider on behalf of the app.
// Plain Node.js, no dependencies. Deploy on Railway: it auto-detects this file.
import http from "node:http";

const PORT = process.env.PORT || 3000;
const UA = "VLC/3.0.20 LibVLC/3.0.20";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, { ...cors, "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}

function resolveUrl(base, value) {
  try { return new URL(value, base).toString(); } catch { return value; }
}

function proxyUrl(url) {
  return `/api/public/stream?url=${encodeURIComponent(url)}`;
}

function isAllowedTarget(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host !== "localhost" && host !== "0.0.0.0" && host !== "127.0.0.1" && host !== "::1";
  } catch { return false; }
}

const normalizeServer = (value) => String(value || "").trim().replace(/\/+$/, "");

async function xtreamGet(server, username, password, params = {}) {
  const url = new URL(`${server}/player_api.php`);
  url.searchParams.set("username", username);
  url.searchParams.set("password", password);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json, */*" } });
  const text = await response.text();
  if (!response.ok || !text.trim()) {
    console.error("xtream upstream", response.status, params.action ?? "login", text.slice(0, 200));
    if (response.status === 401 || response.status === 403 || response.status === 512 || !text.trim())
      throw new Error("The provider refused this login. Check the server URL, username and password.");
    throw new Error(`The provider is not responding correctly (code ${response.status}).`);
  }
  try { return JSON.parse(text); } catch {
    console.error("xtream invalid json", response.status, text.slice(0, 200));
    throw new Error("The provider returned invalid data.");
  }
}

async function handleXtreamPost(req, res, body) {
  try {
    const mode = body.mode === "m3u" ? "m3u" : "xtream";
    if (mode === "m3u") {
      if (!body.m3u) return sendJson(res, { error: "Playlist URL is required." }, 400);
      const response = await fetch(body.m3u, { cache: "no-store" });
      if (!response.ok) return sendJson(res, { error: "Could not fetch that playlist URL." }, 400);
      const channels = []; const categories = new Set();
      let pending;
      for (const line of (await response.text()).split(/\r?\n/)) {
        if (line.startsWith("#EXTINF")) {
          pending = { name: line.match(/,(.*)$/)?.[1]?.trim() || `Channel ${channels.length + 1}`, logo: line.match(/tvg-logo="([^"]*)"/)?.[1], category: line.match(/group-title="([^"]*)"/)?.[1] || "General" };
        } else if (line.trim() && !line.startsWith("#") && pending) {
          categories.add(pending.category);
          channels.push({ id: String(channels.length + 1), ...pending, stream: proxyUrl(line.trim()), direct: line.trim(), type: "live" });
          pending = undefined;
        }
      }
      return sendJson(res, { user: "Playlist", categories: [...categories], channels, movies: [], series: [], session: { mode: "m3u" } });
    }

    const server = normalizeServer(body.server); const username = body.username ?? ""; const password = body.password ?? "";
    if (!server || !username || !password) return sendJson(res, { error: "Server, username and password are required." }, 400);
    const auth = await xtreamGet(server, username, password);
    const userInfo = auth.user_info;
    if (userInfo?.auth !== 1) return sendJson(res, { error: "Invalid credentials or inactive subscription." }, 401);
    const actions = ["get_live_categories", "get_live_streams", "get_vod_categories", "get_vod_streams", "get_series_categories", "get_series"];
    const [liveCats = [], liveStreams = [], vodCats = [], vodStreams = [], seriesCats = [], seriesStreams = []] =
      await Promise.all(actions.map((action) => xtreamGet(server, username, password, { action })));
    const catName = (list, id) => String(list.find((item) => String(item.category_id) === String(id))?.category_name ?? "General");
    const liveUrl = (id) => `${server}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.m3u8`;
    const movieUrl = (id, ext) => `${server}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.${String(ext || "mp4")}`;
    const channels = liveStreams.map((item) => ({ id: String(item.stream_id), name: String(item.name ?? "Untitled"), logo: String(item.stream_icon ?? ""), category: catName(liveCats, item.category_id), type: "live", stream: proxyUrl(liveUrl(item.stream_id)), direct: liveUrl(item.stream_id) }));
    const movies = vodStreams.map((item) => ({ id: String(item.stream_id), name: String(item.name ?? "Untitled"), logo: String(item.stream_icon ?? ""), category: catName(vodCats, item.category_id), type: "movie", stream: proxyUrl(movieUrl(item.stream_id, item.container_extension)), direct: movieUrl(item.stream_id, item.container_extension) }));
    const series = seriesStreams.map((item) => ({ id: String(item.series_id), name: String(item.name ?? "Untitled"), logo: String(item.cover ?? ""), category: catName(seriesCats, item.category_id), type: "series", stream: "" }));
    return sendJson(res, { user: String(userInfo?.username ?? username), categories: liveCats.map((item) => String(item.category_name)), channels, movies, series, session: { mode: "xtream", server, username, password } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to connect.";
    return sendJson(res, { error: message }, message.includes("refused this login") ? 401 : 502);
  }
}

async function handleXtreamPut(res, body) {
  try {
    const server = normalizeServer(body.server); const username = body.username ?? ""; const password = body.password ?? "";
    if (!server || !username || !password || !body.action || !body.id) return sendJson(res, { error: "Missing parameters." }, 400);
    const params = body.action === "epg" ? { action: "get_short_epg", stream_id: body.id } : { action: "get_series_info", series_id: body.id };
    return sendJson(res, await xtreamGet(server, username, password, params));
  } catch (error) {
    console.error("[xtream] detail request failed", error);
    return sendJson(res, { error: error instanceof Error ? error.message : "Request failed.", epg_listings: [], episodes: {} });
  }
}

async function streamUpstream(req, res, target) {
  let upstream; let finalUrl = target;
  try {
    const headers = { "User-Agent": UA, Accept: "*/*" };
    if (req.headers.range) headers.Range = req.headers.range;
    // Follow redirects manually: IPTV providers often redirect to IP:port hosts that automatic following rejects.
    for (let hop = 0; hop < 5; hop++) {
      const result = await fetch(finalUrl, { headers, redirect: "manual" });
      const location = result.headers.get("location");
      if (result.status >= 300 && result.status < 400 && location) {
        const next = resolveUrl(finalUrl, location);
        if (!isAllowedTarget(next)) { res.writeHead(400, cors); return res.end("Invalid redirect"); }
        finalUrl = next;
        continue;
      }
      upstream = result;
      break;
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    console.error("[stream] fetch failed", finalUrl, error);
    res.writeHead(502, cors); return res.end("Stream provider is unavailable");
  }
  if (!upstream) { res.writeHead(502, cors); return res.end("Too many redirects"); }

  if (!upstream.ok && upstream.status !== 206) {
    // 509/429 = provider connection limit (often a previous channel still open). Report as temporary.
    const limited = upstream.status === 509 || upstream.status === 429;
    console.warn("[stream] upstream status", upstream.status, finalUrl);
    res.writeHead(limited ? 503 : upstream.status >= 500 ? 502 : upstream.status, { ...cors, "retry-after": "3", "cache-control": "no-store" });
    return res.end(limited ? "Provider connection limit reached" : "Upstream error");
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const isPlaylist = new URL(finalUrl).pathname.toLowerCase().endsWith(".m3u8") || new URL(target).pathname.toLowerCase().endsWith(".m3u8") || contentType.includes("mpegurl");

  if (isPlaylist) {
    const base = finalUrl;
    const playlist = (await upstream.text()).split(/\r?\n/).map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${proxyUrl(resolveUrl(base, uri))}"`);
      return proxyUrl(resolveUrl(base, line.trim()));
    }).join("\n");
    res.writeHead(200, { ...cors, "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" });
    return res.end(playlist);
  }

  const headers = { ...cors };
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  if (!headers["accept-ranges"]) headers["accept-ranges"] = "bytes";
  res.writeHead(upstream.status, headers);
  for await (const chunk of upstream.body) {
    if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
  }
  res.end();
}

async function handleStream(req, res, requestUrl) {
  const target = requestUrl.searchParams.get("url");
  if (!target || !isAllowedTarget(target)) {
    res.writeHead(400, cors); return res.end("Invalid stream URL");
  }
  return streamUpstream(req, res, target);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (requestUrl.pathname === "/health") {
    res.writeHead(200, { ...cors, "content-type": "text/plain" }); return res.end("MMN relay is running");
  }
  if (requestUrl.pathname === "/api/public/stream" && req.method === "GET") return handleStream(req, res, requestUrl);
  if (requestUrl.pathname === "/api/public/xtream" && (req.method === "POST" || req.method === "PUT")) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { res.writeHead(400, cors); return res.end("Invalid JSON"); }
    return req.method === "POST" ? handleXtreamPost(req, res, body) : handleXtreamPut(res, body);
  }
  res.writeHead(404, cors); res.end("Not found");
});

server.listen(PORT, () => console.log(`MMN relay listening on port ${PORT}`));
