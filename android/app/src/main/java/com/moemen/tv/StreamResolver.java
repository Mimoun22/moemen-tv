package com.moemen.tv;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Resolves aniwaves (echovideo) embeds — plus legacy MegaPlay/my.1anime
 * fallbacks — to direct playable streams
 * (mirror of server.js): getSourcesNew -> AES-decrypt master URL.
 * Playlists referencing /segment/&lt;token&gt; URLs are decrypted and rewritten
 * to local cached playlists so ExoPlayer can play them directly.
 */
public class StreamResolver {
    public static final String UA = "Mozilla/5.0 (Linux; Android 11; TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 MoemenTV/1.0";
    private static final String PAGE_REF = "https://aniwaves.ru/";
    private static final String MEGA = "https://megaplay.buzz";

    // Writable playlist cache (java.io.tmpdir is NOT app-writable on Android).
    private static volatile File hlsDir;

    /** Call once from an Activity (Main/Mobile/Player) and from Downloader. */
    public static synchronized void init(File appCacheDir) {
        try {
            File d = new File(appCacheDir, "hls");
            if (d.exists() || d.mkdirs()) hlsDir = d;
        } catch (Exception ignored) { }
    }

    public static class Track {
        public final String label;
        public final String file;
        Track(String l, String f) { label = l; file = f; }
    }

    public static class Stream {
        public String file;
        public String type = "hls";
        public String poster = "";
        public String referer = PAGE_REF;
        public double duration = 0;
        public final List<Track> tracks = new ArrayList<>();
    }

    public static Stream resolve(String embedUrl) throws Exception {
        Stream s = new Stream();
        if (embedUrl == null || (!embedUrl.startsWith("http://") && !embedUrl.startsWith("https://"))) {
            // raw aniwaves link-id
            resolveAniwaves(embedUrl, s);
            return s;
        }
        String host = new URL(embedUrl).getHost().toLowerCase(java.util.Locale.US);
        parseTracks(embedUrl, s);
        if (host.contains("1anime.site")) {
            if (embedUrl.contains("/play/")) resolveMyAnime(embedUrl, s);
            else resolveMega(embedUrl, s);
        } else if (host.contains("megaplay")) {
            resolveMega(embedUrl, s);
        } else {
            throw new Exception("host not resolvable");
        }
        return s;
    }

    /**
     * Aniwaves link-id: ajax/sources -&gt; echovideo embed -&gt; getSources.
     * embed-1 style returns an HLS master string; embed-20 style returns
     * {HD,SD,HQ} MP4 lists. No subtitles are published.
     */
    private static void resolveAniwaves(String linkId, Stream s) throws Exception {
        if (linkId == null || linkId.isEmpty()) throw new Exception("missing embed");
        JSONObject src = new JSONObject(httpText(
                PAGE_REF + "ajax/sources?id=" + java.net.URLEncoder.encode(linkId, "UTF-8") + "&asi=0&autoPlay=0", PAGE_REF));
        JSONObject result = src.optJSONObject("result");
        String embedUrl = result != null ? result.optString("url", "") : "";
        if (embedUrl.isEmpty()) throw new Exception("aniwave: no embed url");
        if (!embedUrl.toLowerCase(java.util.Locale.US).contains("echovideo")) {
            throw new Exception("aniwave: unsupported embed host");
        }
        String html = httpText(embedUrl, PAGE_REF);
        Matcher idm = Pattern.compile("id=\"mg-player\"[^>]*data-id=\"([^\"]+)\"").matcher(html);
        if (!idm.find()) throw new Exception("aniwave: no media id found");
        String dir = embedUrl.split("\\?")[0];
        int slash = dir.lastIndexOf('/');
        if (slash > 8) dir = dir.substring(0, slash);
        JSONObject gs = new JSONObject(httpText(dir + "/getSources?id=" + idm.group(1), embedUrl));
        Object sources = gs.opt("sources");
        if (sources instanceof String && ((String) sources).contains(".m3u8")) {
            String file = (String) sources;
            if (!file.startsWith("http")) file = new URL(new URL(dir), file).toString();
            String master = httpText(file, embedUrl);
            if (!master.contains("#EXTM3U")) throw new Exception("aniwave: bad playlist");
            s.file = file;
            s.type = "hls";
            s.referer = embedUrl;
            return;
        }
        if (sources instanceof JSONObject) {
            JSONObject so = (JSONObject) sources;
            String[] order = {"HD", "HQ", "SD"};
            String best = "";
            for (String k : order) {
                JSONArray arr = so.optJSONArray(k);
                if (arr != null && arr.length() > 0 && !arr.optString(0).isEmpty()) { best = arr.optString(0); break; }
            }
            if (best.isEmpty()) {
                java.util.Iterator<String> keys = so.keys();
                while (keys.hasNext()) {
                    JSONArray arr = so.optJSONArray(keys.next());
                    if (arr != null && arr.length() > 0 && !arr.optString(0).isEmpty()) { best = arr.optString(0); break; }
                }
            }
            if (best.isEmpty()) throw new Exception("aniwave: no stream link found");
            s.file = best;
            s.type = "mp4";
            s.referer = embedUrl;
            return;
        }
        throw new Exception("aniwave: no stream link found");
    }

    /**
     * my.1anime.site/play/&lt;token&gt;: plain Plyr page with a direct mp4
     * &lt;source&gt;. The mp4 host requires a same-origin (play page) referer.
     */
    private static void resolveMyAnime(String embedUrl, Stream s) throws Exception {
        String html = httpText(embedUrl, PAGE_REF);
        Matcher m = Pattern.compile("<source[^>]*src=\"([^\"]+)\"[^>]*type=\"video/mp4\"",
                Pattern.CASE_INSENSITIVE).matcher(html);
        if (!m.find()) {
            m = Pattern.compile("<source[^>]*src=\"([^\"]+)\"",
                    Pattern.CASE_INSENSITIVE).matcher(html);
            if (!m.find()) throw new Exception("myanime: no mp4 source found");
        }
        String file = new URL(new URL(embedUrl), m.group(1)).toString();
        HttpURLConnection c = (HttpURLConnection) new URL(file).openConnection();
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Referer", embedUrl);
        c.setRequestProperty("Range", "bytes=0-0");
        c.setConnectTimeout(20000);
        c.setReadTimeout(20000);
        c.setInstanceFollowRedirects(true);
        int code = c.getResponseCode();
        if (code != HttpURLConnection.HTTP_OK && code != HttpURLConnection.HTTP_PARTIAL) {
            throw new Exception("myanime: stream check " + code);
        }
        String ct = c.getContentType();
        if (ct == null || (!ct.contains("mp4") && !ct.contains("octet"))) {
            throw new Exception("myanime: not a video file");
        }
        s.file = file;
        s.type = "mp4";
        s.referer = embedUrl;
    }

    private static class MegaSources {
        String pageUrl;
        JSONObject json;
    }

    private static MegaSources megaSources(String embedUrl) throws Exception {
        String pageUrl = embedUrl;
        if (new URL(embedUrl).getHost().contains("1anime.site")) {
            String html = httpText(embedUrl, PAGE_REF);
            Matcher m = Pattern.compile("<iframe[^>]*src=\"([^\"]*megaplay[^\"]*)\"",
                    Pattern.CASE_INSENSITIVE).matcher(html);
            if (!m.find()) throw new Exception("1anime: no megaplay iframe found");
            pageUrl = m.group(1);
            if (pageUrl.startsWith("//")) pageUrl = "https:" + pageUrl;
        }
        String html = httpText(pageUrl, PAGE_REF);
        Matcher idm = Pattern.compile("data-id=\"(\\d+)\"").matcher(html);
        if (!idm.find()) throw new Exception("megaplay: no media id found");
        MegaSources out = new MegaSources();
        out.pageUrl = pageUrl;
        out.json = new JSONObject(httpText(MEGA + "/stream/getSourcesNew?id=" + idm.group(1), pageUrl));
        if (out.json.optString("enc", "").isEmpty()) throw new Exception("megaplay: no sources returned");
        return out;
    }

    private static void resolveMega(String embedUrl, Stream s) throws Exception {
        MegaSources src = megaSources(embedUrl);
        String file;
        try {
            JSONObject dec = new JSONObject(megaDecrypt(src.json.getString("enc")));
            file = dec.optString("file", "");
        } catch (Exception e) {
            throw new Exception("megaplay: stream decrypt failed");
        }
        if (file.isEmpty()) throw new Exception("megaplay: no stream link found");
        JSONArray tr = src.json.optJSONArray("tracks");
        if (tr != null) {
            for (int i = 0; i < tr.length(); i++) {
                JSONObject t = tr.optJSONObject(i);
                if (t == null) continue;
                String f = t.optString("file", "");
                if (f.startsWith("http")) s.tracks.add(new Track(
                        t.optString("label", "English").isEmpty() ? "English" : t.optString("label", "English"), f));
            }
        }
        // throws if the master playlist itself is unreachable (lets the player
        // auto-skip to the next server); falls back to remote URL if only the
        // /segment/ rewrite fails
        s.file = localizeHls(file, MEGA + "/");
        s.referer = MEGA + "/";
        s.type = "hls";
    }

    /** Subtitle tracks for an embed without full resolution (no playlist fetch). */
    public static List<Track> fetchMegaTracks(String embedUrl) {
        List<Track> out = new ArrayList<>();
        try {
            MegaSources src = megaSources(embedUrl);
            JSONArray tr = src.json.optJSONArray("tracks");
            if (tr != null) {
                for (int i = 0; i < tr.length(); i++) {
                    JSONObject t = tr.optJSONObject(i);
                    if (t == null) continue;
                    String f = t.optString("file", "");
                    if (f.startsWith("http")) out.add(new Track(
                            t.optString("label", "English").isEmpty() ? "English" : t.optString("label", "English"), f));
                }
            }
        } catch (Exception ignored) { }
        return out;
    }

    /** First SUB server embed in a watch payload (lets DUB borrow SUB timings). */
    public static String firstSubEmbed(JSONObject servers) {
        if (servers == null) return null;
        JSONArray arr = servers.optJSONArray("sub");
        if (arr == null) return null;
        for (int i = 0; i < arr.length(); i++) {
            String embed = arr.optJSONObject(i) != null ? arr.optJSONObject(i).optString("embed", "") : "";
            if (!embed.isEmpty()) return embed;
        }
        return null;
    }

    /**
     * First English VTT URL across server embeds. Tries legacy query-param
     * embeds first, then resolves the SUB MegaPlay embed's tracks.
     * May do network I/O — call off the UI thread.
     */
    public static String englishVttForServers(JSONObject servers) {
        String legacy = englishVttUrl(servers);
        if (legacy != null) return legacy;
        String sub = firstSubEmbed(servers);
        if (sub == null) return null;
        List<Track> tr = fetchMegaTracks(sub);
        return tr.isEmpty() ? null : tr.get(0).file;
    }

    /** Map one playlist segment line to a fetchable URL (decrypts /segment/ tokens). */
    public static String resolveSegmentUrl(String seg, String playlistUrl) {
        Matcher m = Pattern.compile("/segment/([A-Za-z0-9_\\-]+)").matcher(seg);
        if (m.find()) {
            try {
                String dec = megaDecrypt(m.group(1)).trim();
                Matcher u = Pattern.compile("https?://[^\\s\"']+").matcher(dec);
                String real = u.find() ? u.group(0) : dec;
                return new URL(new URL(playlistUrl), real).toString();
            } catch (Exception ignored) { }
        }
        try {
            return new URL(new URL(playlistUrl), seg).toString();
        } catch (Exception e) {
            return seg;
        }
    }

    // ---- MegaPlay AES-256-CBC (key "i?LMTAx0Q6,:}50U"+zeros, iv "W0;27ToaUpl_P%'c") ----
    public static String megaDecrypt(String token) throws Exception {
        String b64 = token.replace('-', '+').replace('_', '/');
        while (b64.length() % 4 != 0) b64 += "=";
        byte[] raw = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
        byte[] key = new byte[32];
        byte[] kb = "i?LMTAx0Q6,:}50U".getBytes("UTF-8");
        System.arraycopy(kb, 0, key, 0, kb.length);
        byte[] iv = "W0;27ToaUpl_P%'c".getBytes("UTF-8");
        javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/CBC/PKCS5Padding");
        c.init(javax.crypto.Cipher.DECRYPT_MODE,
                new javax.crypto.spec.SecretKeySpec(key, "AES"),
                new javax.crypto.spec.IvParameterSpec(iv));
        return new String(c.doFinal(raw), "UTF-8");
    }

    /**
     * Rewrite a playlist's /segment/&lt;token&gt; URLs to real absolute URLs and,
     * for multi-variant masters, materialize every variant locally so ExoPlayer
     * (which cannot run the site's in-browser decryptor) plays a fully static
     * local playlist graph. Returns a file:// URL, or the remote URL when
     * nothing needed rewriting. Throws when the master itself is unreachable.
     */
    private static String localizeHls(String masterUrl, String referer) throws Exception {
        String master = httpText(masterUrl, referer);
        if (!master.contains("#EXTM3U")) throw new Exception("bad playlist");
        try {
            File dir = hlsDir;
            if (dir == null) {
                dir = new File(System.getProperty("java.io.tmpdir"), "hls");
                dir.mkdirs();
            }
            String base = "m" + Math.abs(masterUrl.hashCode());
            if (master.contains("#EXT-X-STREAM-INF")) {
                String[] lines = master.split("\n");
                StringBuilder out = new StringBuilder();
                int vi = 0;
                for (String l : lines) {
                    String t = l.trim();
                    if (!t.isEmpty() && !t.startsWith("#")) {
                        String vurl = new URL(new URL(masterUrl), t).toString();
                        try {
                            String vt = decryptSegments(httpText(vurl, referer), vurl);
                            File vf = new File(dir, base + "-v" + (vi++) + ".m3u8");
                            writeFile(vf, vt);
                            out.append(vf.toURI().toString()).append("\n");
                            continue;
                        } catch (Exception e) { /* keep original line */ }
                    }
                    out.append(decryptInline(l, masterUrl)).append("\n");
                }
                File mf = new File(dir, base + "-master.m3u8");
                writeFile(mf, out.toString());
                return mf.toURI().toString();
            }
            String fixed = decryptSegments(master, masterUrl);
            if (fixed.equals(master)) return masterUrl;
            File mf = new File(dir, base + "-single.m3u8");
            writeFile(mf, fixed);
            return mf.toURI().toString();
        } catch (Exception e) {
            return masterUrl;
        }
    }

    /** Replace every absolute or bare /segment/&lt;token&gt; with its decrypted absolute URL. */
    private static String decryptSegments(String text, String baseUrl) {
        Matcher m = Pattern.compile("https?://[^\\s\"']*?/segment/[A-Za-z0-9_\\-]+|/segment/[A-Za-z0-9_\\-]+").matcher(text);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            String hit = m.group(0);
            Matcher tm = Pattern.compile("/segment/([A-Za-z0-9_\\-]+)").matcher(hit);
            String rep = hit;
            if (tm.find()) {
                try {
                    String dec = megaDecrypt(tm.group(1)).trim();
                    Matcher u = Pattern.compile("https?://[^\\s\"']+").matcher(dec);
                    String real = u.find() ? u.group(0) : dec;
                    rep = new URL(new URL(baseUrl), real).toString();
                } catch (Exception ignored) { }
            }
            m.appendReplacement(sb, Matcher.quoteReplacement(rep));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    private static String decryptInline(String line, String baseUrl) {
        if (line.contains("/segment/")) return decryptSegments(line, baseUrl);
        return line;
    }

    private static void writeFile(File f, String s) throws Exception {
        FileOutputStream fos = new FileOutputStream(f);
        fos.write(s.getBytes("UTF-8"));
        fos.close();
    }

    private static void parseTracks(String embedUrl, Stream s) {
        try {
            URL u = new URL(embedUrl);
            String q = u.getQuery();
            if (q == null) return;
            Map<String, String> params = new LinkedHashMap<>();
            for (String kv : q.split("&")) {
                int eq = kv.indexOf('=');
                if (eq > 0) params.put(URLDecoder.decode(kv.substring(0, eq), "UTF-8"),
                        URLDecoder.decode(kv.substring(eq + 1), "UTF-8"));
            }
            String sub = params.get("sub");
            String cap = params.get("caption_1");
            String c1 = params.get("c1_file");
            if (sub != null && sub.startsWith("http")) s.tracks.add(new Track(params.get("sub_1") != null ? params.get("sub_1") : "English", sub));
            if (cap != null && cap.startsWith("http")) s.tracks.add(new Track(params.get("sub_1") != null ? params.get("sub_1") : "English", cap));
            if (c1 != null && c1.startsWith("http")) s.tracks.add(new Track(params.get("c1_label") != null ? params.get("c1_label") : "English", c1));
        } catch (Exception ignored) { }
    }

    private static String httpText(String url, String ref) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Referer", ref != null ? ref : PAGE_REF);
        c.setRequestProperty("Accept", "*/*");
        c.setRequestProperty("Accept-Encoding", "gzip");
        c.setConnectTimeout(20000);
        c.setReadTimeout(25000);
        c.setInstanceFollowRedirects(true);
        int code = c.getResponseCode();
        if (code < 200 || code >= 300) throw new Exception("upstream " + code);
        String enc = c.getContentEncoding();
        InputStream in = c.getInputStream();
        if (enc != null && enc.contains("gzip")) in = new java.util.zip.GZIPInputStream(in);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        int total = 0;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            total += n;
            if (total > 4 * 1024 * 1024) break;
        }
        in.close();
        return out.toString("UTF-8");
    }

    /** First English VTT URL across legacy query-param embeds (no network). */
    public static String englishVttUrl(org.json.JSONObject servers) {
        if (servers == null) return null;
        String[] langs = {"sub", "dub", "hsub"};
        String[] keys = {"sub", "caption_1", "c1_file"};
        for (String l : langs) {
            org.json.JSONArray arr = servers.optJSONArray(l);
            if (arr == null) continue;
            for (int i = 0; i < arr.length(); i++) {
                String embed = arr.optJSONObject(i) != null ? arr.optJSONObject(i).optString("embed", "") : "";
                int qi = embed.indexOf('?');
                if (qi < 0) continue;
                for (String kv : embed.substring(qi + 1).split("&")) {
                    int eq = kv.indexOf('=');
                    if (eq < 0) continue;
                    try {
                        String k = java.net.URLDecoder.decode(kv.substring(0, eq), "UTF-8");
                        String v = java.net.URLDecoder.decode(kv.substring(eq + 1), "UTF-8");
                        for (String want : keys) {
                            if (k.equals(want) && v.startsWith("http")) return v;
                        }
                    } catch (Exception ignored) { }
                }
            }
        }
        return null;
    }

    /** Quality variants of a master playlist (best effort). */
    public static class Variant {
        public int height;
        public long bandwidth;
        public String url;
        public String label;
    }

    /** Read a playlist over http(s) or from a localized file:// cache copy. */
    public static String readPlaylist(String url, String ref) throws Exception {
        if (url.startsWith("file:")) {
            java.io.File f = new java.io.File(new URL(url).toURI());
            byte[] buf = new byte[(int) Math.min(f.length(), 4 * 1024 * 1024)];
            java.io.FileInputStream fis = new java.io.FileInputStream(f);
            int total = 0, n;
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            while ((n = fis.read(buf)) > 0) { bos.write(buf, 0, n); total += n; }
            fis.close();
            return bos.toString("UTF-8");
        }
        return httpText(url, ref);
    }

    public static java.util.List<Variant> variants(String masterUrl, String ref) {
        java.util.List<Variant> out = new java.util.ArrayList<>();
        try {
            String text = readPlaylist(masterUrl, ref);
            if (!text.contains("#EXT-X-STREAM-INF")) return out;
            String[] lines = text.split("\n");
            for (int i = 0; i < lines.length; i++) {
                String l = lines[i].trim();
                if (!l.startsWith("#EXT-X-STREAM-INF")) continue;
                long bw = 0;
                int h = 0;
                Matcher bm = Pattern.compile("BANDWIDTH=(\\d+)").matcher(l);
                if (bm.find()) {
                    try { bw = Long.parseLong(bm.group(1)); } catch (Exception ignored) { }
                }
                Matcher rm = Pattern.compile("RESOLUTION=\\d+x(\\d+)").matcher(l);
                if (rm.find()) {
                    try { h = Integer.parseInt(rm.group(1)); } catch (Exception ignored) { }
                }
                if (i + 1 >= lines.length) continue;
                String rel = lines[i + 1].trim();
                if (rel.isEmpty() || rel.startsWith("#")) continue;
                Variant v = new Variant();
                v.height = h;
                v.bandwidth = bw;
                v.url = new URL(new URL(masterUrl), rel).toString();
                v.label = h > 0 ? (h + "p") : (bw > 0 ? ((bw / 1000) + "k") : "Auto");
                out.add(v);
            }
        } catch (Exception ignored) { }
        return out;
    }

    public static Variant pickVariant(java.util.List<Variant> vars, int quality) {
        if (vars == null || vars.isEmpty()) return null;
        java.util.List<Variant> sorted = new java.util.ArrayList<>(vars);
        java.util.Collections.sort(sorted, (a, b) ->
                Long.compare(b.height > 0 ? b.height : b.bandwidth, a.height > 0 ? a.height : a.bandwidth));
        if (quality <= 0) return sorted.get(0);
        Variant fallback = sorted.get(sorted.size() - 1);
        for (int i = sorted.size() - 1; i >= 0; i--) {
            Variant v = sorted.get(i);
            if (v.height > 0 && v.height <= quality) return v;
            fallback = v;
        }
        return fallback;
    }

    public static JSONObject toJson(Stream s) throws Exception {        JSONObject o = new JSONObject();
        o.put("file", s.file);
        o.put("type", s.type);
        o.put("poster", s.poster);
        o.put("referer", s.referer);
        o.put("duration", s.duration);
        JSONArray tr = new JSONArray();
        for (Track t : s.tracks) {
            tr.put(new JSONObject().put("label", t.label).put("file", t.file));
        }
        o.put("tracks", tr);
        o.put("playable", true);
        return o;
    }
}
