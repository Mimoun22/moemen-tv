package com.moemen.tv;

import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Live bridge: fetches aniwaves.ru HTML natively (no CORS in native code),
 * parses it with Jsoup (same selectors as server.js) and returns JSON
 * to the WebView UI via window.AniNeko.api(path).
 */
public class ApiBridge {
    private static final String BASE = "https://aniwaves.ru";
    private static final String UA = "Mozilla/5.0 (Linux; Android 11; TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 MoemenTV/1.0";
    private static final long TTL = 5 * 60 * 1000;

    private static class Entry { long t; String v; }

    private final Map<String, Entry> cache = new HashMap<>();

    // Mirrored UI state for remote BACK handling in MainActivity
    public volatile boolean playerOpen = false;
    public volatile boolean searchOpen = false;
    public volatile String view = "home";

    private android.app.Activity activity;
    private boolean tvMode = true;
    private int playerReq = 1001;
    public ApiBridge() { }
    public ApiBridge(android.app.Activity a) { this(a, true); }
    public ApiBridge(android.app.Activity a, boolean tv) { activity = a; tvMode = tv; playerReq = tv ? 1001 : 1002; }

    /** Phone shell shows downloads; TV shell hides them. */
    @JavascriptInterface
    public boolean isTV() { return tvMode; }

    /** Started from the download chooser (mobile). Runs fully in background. */
    @JavascriptInterface
    public void downloadEpisode(String json) {
        try {
            if (activity != null) Downloader.enqueue(activity.getApplicationContext(), json);
        } catch (Exception ignored) { }
    }

    /** Launch the native ExoPlayer with a full session payload from the WebView UI. */
    @JavascriptInterface
    public void playNative(String json) {
        try {
            if (activity == null) return;
            JSONObject o = new JSONObject(json);
            android.content.Intent i = new android.content.Intent(activity, PlayerActivity.class);
            i.putExtra(PlayerActivity.EX_SLUG, o.optString("slug", ""));
            i.putExtra(PlayerActivity.EX_EP, o.optInt("ep", 1));
            i.putExtra(PlayerActivity.EX_TITLE, o.optString("title", ""));
            i.putExtra(PlayerActivity.EX_POSTER, o.optString("poster", ""));
            i.putExtra(PlayerActivity.EX_LANG, o.optString("lang", "sub"));
            i.putExtra(PlayerActivity.EX_SERVERS, o.optJSONObject("servers") != null
                    ? o.optJSONObject("servers").toString() : "{}");
            i.putExtra(PlayerActivity.EX_EPISODES, o.optJSONArray("episodes") != null
                    ? o.optJSONArray("episodes").toString() : "[]");
            i.putExtra(PlayerActivity.EX_POS, (long) (o.optDouble("pos", 0) * 1000));
            activity.startActivityForResult(i, playerReq);
        } catch (Exception ignored) { }
    }

    /** Reusable by PlayerActivity for prev/next episode server lists. */
    public JSONObject getWatch(String slug, int ep) throws Exception {
        return cached("watch:" + slug + ":" + ep, false, new Loader() {
            public JSONObject load() throws Exception { return scrapeWatch(slug, ep); }
        });
    }

    @JavascriptInterface
    public void setState(String json) {
        try {
            JSONObject o = new JSONObject(json);
            playerOpen = o.optBoolean("playerOpen", false);
            searchOpen = o.optBoolean("searchOpen", false);
            view = o.optString("view", "home");
        } catch (Exception ignored) { }
    }

    @JavascriptInterface
    public String api(String path) {
        try {
            return dispatch(path).toString();
        } catch (Exception e) {
            try {
                return new JSONObject().put("error", String.valueOf(e.getMessage())).toString();
            } catch (Exception x) {
                return "{\"error\":\"unknown\"}";
            }
        }
    }

    // ---------------- dispatch ----------------
    private JSONObject dispatch(String path) throws Exception {
        String p = path;
        boolean refresh = p.contains("refresh=1");
        if (p.startsWith("/api/home")) return cached("home", refresh, new Loader() {
            public JSONObject load() throws Exception { return scrapeHome(); }
        });
        if (p.startsWith("/api/schedule")) return cached("schedule", true, new Loader() {
            public JSONObject load() throws Exception { return scrapeSchedule(); }
        });
        if (p.startsWith("/api/search")) {
            String q = queryParam(p, "q");
            if (q.isEmpty()) q = queryParam(p, "keyword");
            final String fq = q;
            return cached("search:" + fq, refresh, new Loader() {
                public JSONObject load() throws Exception { return scrapeSearch(fq); }
            });
        }
        if (p.startsWith("/api/browse")) {
            String qs = "";
            int qi = p.indexOf('?');
            if (qi >= 0) qs = p.substring(qi + 1).replace("refresh=1&", "").replace("&refresh=1", "").replace("refresh=1", "");
            final String fqs = qs;
            return cached("browse:" + fqs, refresh, new Loader() {
                public JSONObject load() throws Exception { return scrapeBrowse(fqs); }
            });
        }
        if (p.startsWith("/api/stream")) {
            final String embed = queryParam(p, "embed");
            final String subSrc = queryParam(p, "subSrc");
            if (embed.isEmpty()) throw new Exception("missing embed");
            return cached("stream:" + embed + "|" + subSrc, refresh, new Loader() {
                public JSONObject load() throws Exception {
                    StreamResolver.Stream st = StreamResolver.resolve(embed);
                    if (st.tracks.isEmpty() && !subSrc.isEmpty() && !subSrc.equals(embed)) {
                        for (StreamResolver.Track t : StreamResolver.fetchMegaTracks(subSrc)) st.tracks.add(t);
                    }
                    JSONObject o = StreamResolver.toJson(st);
                    if ("hls".equals(o.optString("type")) && st.file != null) {
                        try {
                            JSONArray va = new JSONArray();
                            for (StreamResolver.Variant vv : StreamResolver.variants(st.file, st.referer)) {
                                va.put(new JSONObject().put("height", vv.height)
                                        .put("bandwidth", vv.bandwidth).put("url", vv.url).put("label", vv.label));
                            }
                            o.put("variants", va);
                        } catch (Exception ignored) { }
                    }
                    o.put("fetchedAt", now());
                    return o;
                }
            });
        }
        Matcher m = Pattern.compile("/api/anime/([a-z0-9\\-]+)").matcher(p);
        if (m.find()) {
            final String slug = m.group(1);
            return cached("anime:" + slug, refresh, new Loader() {
                public JSONObject load() throws Exception { return scrapeAnime(slug); }
            });
        }
        Matcher w = Pattern.compile("/api/watch/([a-z0-9\\-]+)/(.+)").matcher(p);
        if (w.find()) {
            final String slug = w.group(1);
            final int ep = Integer.parseInt(w.group(2).replaceAll("\\D", ""));
            return cached("watch:" + slug + ":" + ep, refresh, new Loader() {
                public JSONObject load() throws Exception { return scrapeWatch(slug, ep); }
            });
        }
        throw new Exception("unknown api path: " + path);
    }

    private interface Loader { JSONObject load() throws Exception; }

    private synchronized JSONObject cached(String key, boolean force, Loader l) throws Exception {
        if (!force) {
            Entry e = cache.get(key);
            if (e != null && System.currentTimeMillis() - e.t < TTL) return new JSONObject(e.v);
        }
        JSONObject v = l.load();
        Entry e = new Entry();
        e.t = System.currentTimeMillis();
        e.v = v.toString();
        cache.put(key, e);
        return v;
    }

    // ---------------- http ----------------
    private String fetchPage(String url) throws Exception {
        return fetchWithHeaders(url, BASE + "/", null);
    }

    private String fetchJson(String url, String ref) throws Exception {
        return fetchWithHeaders(url, ref != null ? ref : BASE + "/", "application/json");
    }

    private String fetchWithHeaders(String url, String ref, String accept) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
        c.setRequestProperty("Referer", ref);
        c.setRequestProperty("Accept", accept != null ? accept : "text/html,*/*");
        c.setRequestProperty("Accept-Encoding", "gzip");
        c.setConnectTimeout(20000);
        c.setReadTimeout(20000);
        c.setInstanceFollowRedirects(true);
        int code = c.getResponseCode();
        if (code < 200 || code >= 300) throw new Exception("upstream " + code);
        InputStream in = c.getInputStream();
        String enc = c.getContentEncoding();
        if (enc != null && enc.contains("gzip")) in = new java.util.zip.GZIPInputStream(in);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }

    private static String now() {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new java.util.Date());
    }

    private static String queryParam(String path, String name) {
        try {
            int qi = path.indexOf('?');
            if (qi < 0) return "";
            for (String kv : path.substring(qi + 1).split("&")) {
                int eq = kv.indexOf('=');
                if (eq > 0 && java.net.URLDecoder.decode(kv.substring(0, eq), "UTF-8").equals(name)) {
                    return java.net.URLDecoder.decode(kv.substring(eq + 1), "UTF-8");
                }
            }
        } catch (Exception ignored) { }
        return "";
    }

    private static Map<String, List<String>> queryAll(String qs) {
        Map<String, List<String>> out = new LinkedHashMap<>();
        try {
            for (String kv : qs.split("&")) {
                if (kv.isEmpty()) continue;
                int eq = kv.indexOf('=');
                String k = eq > 0 ? java.net.URLDecoder.decode(kv.substring(0, eq), "UTF-8") : kv;
                String v = eq > 0 ? java.net.URLDecoder.decode(kv.substring(eq + 1), "UTF-8") : "";
                if (!out.containsKey(k)) out.put(k, new ArrayList<String>());
                out.get(k).add(v);
            }
        } catch (Exception ignored) { }
        return out;
    }

    // ---------------- helpers (mirror server.js) ----------------
    private static String abs(String u) {
        if (u == null || u.isEmpty()) return "";
        if (u.startsWith("http")) return u;
        if (u.startsWith("//")) return "https:" + u;
        return BASE + (u.startsWith("/") ? u : "/" + u);
    }

    private static String imgSrc(Element img) {
        if (img == null) return "";
        String s = img.attr("data-src");
        if (s.isEmpty()) s = img.attr("src");
        if (s.isEmpty()) s = img.attr("data-lazy-src");
        return abs(s);
    }

    private static String slugFromHref(String href) {
        if (href == null) return "";
        Matcher m = Pattern.compile("/watch/([a-z0-9\\-]+)/?(?:[?#]|$)", Pattern.CASE_INSENSITIVE).matcher(href);
        return m.find() ? m.group(1) : "";
    }

    private static String showIdFromSlug(String slug) {
        if (slug == null) return "";
        Matcher m = Pattern.compile("-(\\d+)$").matcher(slug);
        return m.find() ? m.group(1) : "";
    }

    private static int epFromHref(String href) {
        if (href == null) return -1;
        Matcher m = Pattern.compile("/ep-(\\d+)", Pattern.CASE_INSENSITIVE).matcher(href);
        return m.find() ? Integer.parseInt(m.group(1)) : -1;
    }

    private static int numIn(String s) {
        if (s == null) return 0;
        Matcher m = Pattern.compile("(\\d+)").matcher(s);
        return m.find() ? Integer.parseInt(m.group(1)) : 0;
    }

    private static String txt(Element root, String css) {
        if (root == null) return "";
        Element e = root.selectFirst(css);
        return e == null ? "" : e.text().trim();
    }

    private JSONObject parseCard(Element el) throws Exception {
        String href = "";
        if ("a".equalsIgnoreCase(el.tagName()) && el.hasAttr("href")
                && el.attr("href").contains("/watch/")) {
            href = el.attr("href");
        } else {
            Elements links = el.select("a[href*=/watch/]");
            if (!links.isEmpty()) href = links.first().attr("href");
        }
        String slug = slugFromHref(href);
        if (slug.isEmpty()) return null;
        Element img = el.selectFirst("img");
        Element titleEl = el.selectFirst("a.name, .name.d-title, .film-name");
        String title = titleEl != null ? titleEl.text().trim() : "";
        if (title.isEmpty() && img != null) title = img.attr("alt").trim();
        title = title.replaceAll("(?i)\\s+Japanese english subbed$", "").trim();
        if (title.isEmpty()) title = slug;
        List<String> genres = new ArrayList<>();
        for (Element g : el.select(".genre a, a[href*=/genre/]")) {
            String t = g.text().trim();
            if (!t.isEmpty() && !genres.contains(t) && genres.size() < 5) genres.add(t);
        }
        JSONObject o = new JSONObject();
        o.put("slug", slug);
        o.put("title", title);
        o.put("poster", imgSrc(img));
        o.put("href", "/watch/" + slug);
        o.put("genres", new JSONArray(genres));
        o.put("type", txt(el, ".meta .right").split("\n")[0].trim());
        o.put("subCount", numIn(txt(el, ".ep-status.sub")));
        o.put("dubCount", numIn(txt(el, ".ep-status.dub")));
        return o;
    }

    private Element sectionForHeading(Document doc, String regex) {
        Pattern rx = Pattern.compile(regex, Pattern.CASE_INSENSITIVE);
        for (Element h : doc.select("h2")) {
            if (rx.matcher(h.text()).find()) {
                Element sec = h.closest("section");
                if (sec != null) return sec;
                Element p = h.parent();
                if (p != null && p.parent() != null) return p.parent();
                return h;
            }
        }
        return null;
    }

    // ---------------- scrapers ----------------
    private JSONObject scrapeHome() throws Exception {
        Document doc = Jsoup.parse(fetchPage(BASE + "/home"), BASE);

        JSONArray spotlight = new JSONArray();
        for (Element el : doc.select("#hotest .swiper-slide.item")) {
            Element linkEl = el.selectFirst("a.btn.play");
            String slug = linkEl == null ? "" : slugFromHref(linkEl.attr("href"));
            if (slug.isEmpty()) continue;
            List<String> tags = new ArrayList<>();
            for (Element s : el.select(".meta.icons i")) {
                String t = s.text().trim();
                if (!t.isEmpty()) tags.add(t);
            }
            String bg = "";
            Element cover = el.selectFirst(".image div");
            if (cover != null) {
                Matcher bm = Pattern.compile("url\\(['\"]?(.*?)['\"]?\\)").matcher(cover.attr("style"));
                if (bm.find()) bg = abs(bm.group(1));
            }
            JSONObject o = new JSONObject();
            o.put("slug", slug);
            o.put("title", txt(el, ".d-title"));
            o.put("desc", txt(el, ".synopsis"));
            o.put("backdrop", bg);
            o.put("poster", bg);
            o.put("tags", new JSONArray(tags));
            o.put("genres", new JSONArray());
            if (!o.getString("title").isEmpty() && spotlight.length() < 10) spotlight.put(o);
        }

        JSONArray trending = new JSONArray();
        Map<String, JSONObject> tseen = new LinkedHashMap<>();
        for (Element el : doc.select("#top-anime .item")) {
            JSONObject c = parseCard(el);
            if (c == null || tseen.containsKey(c.getString("slug"))) continue;
            tseen.put(c.getString("slug"), c);
            if (tseen.size() >= 12) break;
        }
        for (JSONObject o : tseen.values()) trending.put(o);

        JSONArray featured = new JSONArray();
        for (String table : new String[]{"newest", "added"}) {
            for (Element el : doc.select(".top-table[data-name=" + table + "] .item")) {
                JSONObject c = parseCard(el);
                if (c != null) featured.put(c);
                if (featured.length() >= 18) break;
            }
            if (featured.length() >= 18) break;
        }

        JSONArray latest = new JSONArray();
        Map<String, JSONObject> seen = new LinkedHashMap<>();
        for (Element el : doc.select("#recent-update .ani.items .item")) {
            Element linkEl = el.selectFirst("a[href*=/watch/]");
            String slug = linkEl == null ? "" : slugFromHref(linkEl.attr("href"));
            if (slug.isEmpty() || seen.containsKey(slug)) continue;
            Element img = el.selectFirst("img");
            Element nameEl = el.selectFirst("a.name");
            String title = nameEl != null ? nameEl.text().trim() : "";
            if (title.isEmpty() && img != null) title = img.attr("alt").trim();
            List<String> genres = new ArrayList<>();
            for (Element g : el.select(".genre a")) {
                String t = g.text().trim();
                if (!t.isEmpty() && !genres.contains(t)) genres.add(t);
            }
            int ep = numIn(txt(el, ".ep-status.sub"));
            if (ep <= 0) ep = numIn(txt(el, ".ep-status.total"));
            if (ep <= 0) ep = 1;
            JSONObject o = new JSONObject();
            o.put("slug", slug);
            o.put("title", title.isEmpty() ? slug : title);
            o.put("poster", imgSrc(img));
            o.put("episode", ep);
            o.put("href", "/watch/" + slug + "/ep-" + ep);
            o.put("time", "");
            o.put("genres", new JSONArray(genres));
            o.put("type", "TV");
            o.put("subCount", numIn(txt(el, ".ep-status.sub")));
            o.put("dubCount", numIn(txt(el, ".ep-status.dub")));
            seen.put(slug, o);
            if (seen.size() >= 15) break;
        }
        for (JSONObject o : seen.values()) latest.put(o);

        JSONObject out = new JSONObject();
        out.put("spotlight", spotlight);
        out.put("featured", featured);
        out.put("trending", trending);
        out.put("latest", latest);
        out.put("fetchedAt", now());
        return out;
    }
    private JSONObject scrapeBrowse(String qs) throws Exception {
        Map<String, List<String>> q = queryAll(qs);
        String keyword = q.containsKey("keyword") && !q.get("keyword").isEmpty() ? q.get("keyword").get(0) : "";
        List<String> genres = new ArrayList<>();
        if (q.containsKey("genre")) genres.addAll(q.get("genre"));
        if (q.containsKey("genre[]")) genres.addAll(q.get("genre[]"));
        String page = q.containsKey("page") && !q.get("page").isEmpty() ? q.get("page").get(0) : "";
        String url;
        if (!genres.isEmpty() && keyword.isEmpty()) {
            url = BASE + "/genre/" + URLEncoder.encode(genres.get(0), "UTF-8");
            if (!page.isEmpty()) url += "?page=" + URLEncoder.encode(page, "UTF-8");
        } else {
            StringBuilder f = new StringBuilder();
            if (!keyword.isEmpty()) f.append("keyword=").append(URLEncoder.encode(keyword, "UTF-8")).append("&");
            if (!page.isEmpty()) f.append("page=").append(URLEncoder.encode(page, "UTF-8")).append("&");
            url = BASE + "/filter?" + f.toString();
        }
        Document doc = Jsoup.parse(fetchPage(url), BASE);
        JSONArray results = new JSONArray();
        Map<String, Boolean> seen = new HashMap<>();
        for (Element el : doc.select(".ani.items .item, .film-list .item, #body .item")) {
            JSONObject c = parseCard(el);
            if (c != null && !seen.containsKey(c.getString("slug"))) {
                seen.put(c.getString("slug"), true);
                results.put(c);
            }
        }
        JSONObject out = new JSONObject();
        out.put("results", results);
        Element h = doc.selectFirst("h1, .page-title");
        out.put("totalText", h != null ? h.text().replaceAll("\\s+", " ").trim()
                : (results.length() + " titles"));
        out.put("resultsCount", results.length());
        out.put("fetchedAt", now());
        return out;
    }

    private JSONObject scrapeSearch(String q) throws Exception {
        JSONObject out = scrapeBrowse("keyword=" + URLEncoder.encode(q, "UTF-8"));
        out.put("totalText", out.optInt("resultsCount", 0) + " results for \"" + q + "\"");
        return out;
    }
    private JSONObject scrapeAnime(String slug) throws Exception {
        String showId = showIdFromSlug(slug);
        if (showId.isEmpty()) throw new Exception("anime not found: " + slug);
        Document doc = Jsoup.parse(fetchPage(BASE + "/watch/" + slug), BASE);
        Element titleEl = doc.selectFirst("h1.title.d-title");
        String title = titleEl == null ? "" : titleEl.text().trim();
        if (title.isEmpty()) throw new Exception("anime not found: " + slug);
        String altTitle = titleEl.attr("data-jp").trim();
        Element descEl = doc.selectFirst(".synopsis .text");
        String desc = descEl != null ? descEl.text().trim() : "";
        if (desc.isEmpty()) {
            Element og = doc.selectFirst("meta[property=og:description]");
            if (og != null) desc = og.attr("content");
        }
        String poster = imgSrc(doc.selectFirst(".binfo .poster img"));
        if (poster.isEmpty()) {
            Element og = doc.selectFirst("meta[property=og:image]");
            if (og != null) poster = abs(og.attr("content"));
        }
        String backdrop = imgSrc(doc.selectFirst(".cover img, #cover img"));
        if (backdrop.isEmpty()) {
            Element og = doc.selectFirst("meta[property=og:image]");
            if (og != null) backdrop = abs(og.attr("content"));
        }
        if (backdrop.isEmpty()) backdrop = poster;
        List<String> genres = new ArrayList<>();
        for (Element a : doc.select(".binfo a[href*=/genre/], .genres a")) {
            String t = a.text().trim();
            if (!t.isEmpty() && !genres.contains(t) && genres.size() < 12) genres.add(t);
        }
        JSONObject stats = new JSONObject();
        String typeTag = "", status = "", release = "";
        for (Element d : doc.select(".binfo .meta .m-item, .binfo .row")) {
            String t = d.text().replaceAll("\\s+", " ").trim();
            Matcher m = Pattern.compile("^(Type|Status|Premiered|Aired|Year|Quality|Duration)\\s*:?\\s*(.+)$",
                    Pattern.CASE_INSENSITIVE).matcher(t);
            if (!m.find()) continue;
            String key = m.group(1).toLowerCase(Locale.US);
            String val = m.group(2).trim();
            if (val.length() > 60) val = val.substring(0, 60);
            if (key.equals("type")) typeTag = val;
            else if (key.equals("status")) status = val;
            else if (key.equals("premiered") || key.equals("aired") || key.equals("year")) release = val;
        }
        stats.put("type", typeTag);
        stats.put("status", status);
        stats.put("release", release);
        stats.put("quality", "HD");
        List<String> tags = new ArrayList<>();
        if (!typeTag.isEmpty()) tags.add(typeTag);
        tags.add("SUB");
        tags.add("HD");

        JSONObject list = new JSONObject(fetchJson(
                BASE + "/ajax/episode/list/" + showId, BASE + "/watch/" + slug));
        Document eps = Jsoup.parse(list.optString("result", ""), BASE);
        JSONArray episodes = new JSONArray();
        List<JSONObject> sorted = new ArrayList<>();
        for (Element a : eps.select("a[href*=/ep-]")) {
            int number;
            try { number = Integer.parseInt(a.attr("data-num")); }
            catch (Exception e) { number = epFromHref(a.attr("href")); }
            if (number <= 0) continue;
            List<String> badges = new ArrayList<>();
            if ("1".equals(a.attr("data-sub"))) badges.add("SUB");
            if ("1".equals(a.attr("data-dub"))) badges.add("DUB");
            if ("1".equals(a.attr("data-filler"))) badges.add("Filler");
            JSONObject o = new JSONObject();
            o.put("number", number);
            o.put("title", "");
            o.put("href", a.attr("href"));
            o.put("badges", new JSONArray(badges));
            sorted.add(o);
        }
        java.util.Collections.sort(sorted, (x, y) -> {
            try { return Integer.compare(x.getInt("number"), y.getInt("number")); }
            catch (Exception e) { return 0; }
        });
        for (JSONObject o : sorted) episodes.put(o);

        JSONObject out = new JSONObject();
        out.put("slug", slug);
        out.put("title", title);
        out.put("altTitle", altTitle.equals(title) ? "" : altTitle);
        out.put("desc", desc);
        out.put("poster", poster);
        out.put("backdrop", backdrop);
        out.put("tags", new JSONArray(tags));
        out.put("genres", new JSONArray(genres));
        out.put("stats", stats);
        out.put("episodes", episodes);
        out.put("episodeCount", episodes.length());
        out.put("fetchedAt", now());
        return out;
    }
    private JSONObject scrapeWatch(String slug, int ep) throws Exception {
        String showId = showIdFromSlug(slug);
        if (showId.isEmpty()) throw new Exception("anime not found: " + slug);
        JSONObject anime = scrapeAnime(slug);
        JSONArray eps = anime.optJSONArray("episodes");
        boolean found = false;
        if (eps != null) {
            for (int i = 0; i < eps.length(); i++) {
                JSONObject e = eps.optJSONObject(i);
                if (e != null && e.optInt("number", -1) == ep) { found = true; break; }
            }
        }
        if (!found) throw new Exception("episode not found: " + slug + " ep-" + ep);
        JSONObject srv = new JSONObject(fetchJson(
                BASE + "/ajax/server/list?servers=" + showId + "&eps=" + ep, BASE + "/watch/" + slug));
        Document sdoc = Jsoup.parse(srv.optString("result", ""), BASE);
        JSONObject servers = new JSONObject();
        servers.put("hsub", new JSONArray());
        servers.put("sub", new JSONArray());
        servers.put("dub", new JSONArray());
        for (Element t : sdoc.select(".servers .type")) {
            String dtype = t.attr("data-type").toLowerCase(Locale.US);
            String bucket = dtype.equals("dub") ? "dub" : dtype.equals("ssub") ? "hsub" : "sub";
            for (Element li : t.select("li[data-link-id]")) {
                String embed = li.attr("data-link-id");
                String name = li.text().trim();
                if (embed.isEmpty()) continue;
                if (name.isEmpty()) name = "Server";
                JSONObject e = new JSONObject();
                e.put("name", name);
                e.put("embed", embed);
                e.put("tab", dtype);
                servers.getJSONArray(bucket).put(e);
            }
        }

        JSONArray episodes = new JSONArray();
        boolean hasPrev = false, hasNext = false;
        if (eps != null) {
            for (int i = 0; i < eps.length(); i++) {
                JSONObject e = eps.optJSONObject(i);
                if (e == null) continue;
                int n = e.optInt("number", -1);
                if (n < 0) continue;
                JSONObject o = new JSONObject();
                o.put("number", n);
                o.put("href", e.optString("href", ""));
                o.put("active", n == ep);
                episodes.put(o);
                if (n == ep - 1) hasPrev = true;
                if (n == ep + 1) hasNext = true;
            }
        }

        JSONObject out = new JSONObject();
        out.put("slug", slug);
        out.put("episode", ep);
        out.put("animeTitle", anime.optString("title", slug));
        out.put("meta", anime.optString("title", slug) + " \u2022 EP " + ep);
        out.put("servers", servers);
        JSONObject langLabels = new JSONObject();
        langLabels.put("sub", "SUB");
        langLabels.put("dub", "DUB");
        langLabels.put("hsub", "S-SUB");
        out.put("langLabels", langLabels);
        out.put("episodes", episodes);
        out.put("hasPrev", hasPrev);
        out.put("hasNext", hasNext);
        out.put("fetchedAt", now());
        return out;
    }

    private JSONObject scrapeSchedule() throws Exception {
        Document doc = Jsoup.parse(fetchPage(BASE + "/updated"), BASE);
        JSONArray results = new JSONArray();
        Map<String, Boolean> seen = new HashMap<>();
        for (Element el : doc.select(".ani.items .item, #body .item")) {
            JSONObject c = parseCard(el);
            if (c != null && !seen.containsKey(c.getString("slug"))) {
                seen.put(c.getString("slug"), true);
                results.put(c);
            }
        }
        JSONObject data = new JSONObject();
        data.put("results", results);
        JSONArray items = new JSONArray();
        if (results != null) {
            for (int i = 0; i < results.length() && i < 30; i++) {
                JSONObject c = results.optJSONObject(i);
                if (c == null) continue;
                JSONObject o = new JSONObject();
                o.put("slug", c.optString("slug", ""));
                o.put("title", c.optString("title", ""));
                o.put("episode", 1);
                o.put("href", "/watch/" + c.optString("slug", ""));
                o.put("time", "");
                o.put("status", "released");
                o.put("poster", c.optString("poster", ""));
                JSONArray g = c.optJSONArray("genres");
                StringBuilder t = new StringBuilder();
                if (g != null) {
                    for (int k = 0; k < g.length(); k++) {
                        if (t.length() > 0) t.append(", ");
                        t.append(g.optString(k));
                    }
                }
                o.put("text", t.toString());
                items.put(o);
            }
        }
        JSONObject out = new JSONObject();
        out.put("items", items);
        out.put("fetchedAt", now());
        return out;
    }
}