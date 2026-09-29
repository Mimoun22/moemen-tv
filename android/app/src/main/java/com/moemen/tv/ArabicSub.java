package com.moemen.tv;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * English -> Arabic subtitle translation on-device (mirror of server.js).
 * Downloads the English VTT, machine-translates cues via keyless endpoint,
 * caches the result as a local file for ExoPlayer. Null on any failure.
 */
public class ArabicSub {
    private static final Map<String, String> MEM = new HashMap<>();

    public static synchronized String get(Context ctx, String vttUrl) {
        if (vttUrl == null || vttUrl.isEmpty()) return null;
        if (MEM.containsKey(vttUrl)) {
            String p = MEM.get(vttUrl);
            if (p != null && new File(p).exists()) return p;
        }
        try {
            File dir = new File(ctx.getCacheDir(), "ar_subs");
            if (!dir.exists()) dir.mkdirs();
            File out = new File(dir, md5(vttUrl) + ".vtt");
            if (out.exists() && out.length() > 100) {
                MEM.put(vttUrl, out.getAbsolutePath());
                return out.getAbsolutePath();
            }
            String raw = httpGet(vttUrl, "https://aniwaves.ru/", null, 1500000);
            List<String[]> cues = parseCues(raw);
            if (cues.isEmpty()) return null;
            List<String> texts = new ArrayList<>();
            for (String[] c : cues) texts.add(c[1].replace("\n", " ").trim());
            List<String> tr = translate(texts);
            StringBuilder vtt = new StringBuilder("WEBVTT - Translated to Arabic (auto)\n\n");
            for (int i = 0; i < cues.size(); i++) {
                String t = i < tr.size() && !tr.get(i).isEmpty() ? tr.get(i) : cues.get(i)[1];
                vtt.append(cues.get(i)[0]).append("\n").append(t).append("\n\n");
            }
            FileOutputStream fos = new FileOutputStream(out);
            fos.write(vtt.toString().getBytes(StandardCharsets.UTF_8));
            fos.close();
            MEM.put(vttUrl, out.getAbsolutePath());
            return out.getAbsolutePath();
        } catch (Exception e) {
            return null;
        }
    }

    private static List<String[]> parseCues(String raw) {
        List<String[]> cues = new ArrayList<>();
        String[] blocks = raw.replace("﻿", "").split("\r?\n\r?\n");
        for (String b : blocks) {
            String[] lines = b.split("\r?\n");
            List<String> keep = new ArrayList<>();
            for (String l : lines) {
                if (!l.trim().isEmpty()) keep.add(l);
            }
            if (keep.isEmpty()) continue;
            if (keep.get(0).toUpperCase(java.util.Locale.US).startsWith("WEBVTT")) continue;
            int ti = -1;
            for (int i = 0; i < keep.size(); i++) {
                if (keep.get(i).contains("-->")) { ti = i; break; }
            }
            if (ti < 0) continue;
            StringBuilder text = new StringBuilder();
            for (int i = ti + 1; i < keep.size(); i++) {
                if (text.length() > 0) text.append("\n");
                text.append(keep.get(i));
            }
            String t = text.toString().replaceAll("<[^>]*>", "").trim();
            if (t.isEmpty()) continue;
            cues.add(new String[]{keep.get(ti).trim(), t});
        }
        return cues;
    }

    private static List<String> translate(List<String> texts) throws Exception {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < texts.size(); i += 40) {
            List<String> batch = texts.subList(i, Math.min(i + 40, texts.size()));
            try {
                List<String> got = gtx(batch);
                boolean ok = got.size() == batch.size();
                if (ok) {
                    for (String g : got) {
                        if (g == null || g.isEmpty()) { ok = false; break; }
                    }
                }
                if (!ok) throw new Exception("shape");
                out.addAll(got);
            } catch (Exception e) {
                // smaller retries, then cue-by-cue, then give up per cue
                for (int j = 0; j < batch.size(); j += 8) {
                    List<String> micro = batch.subList(j, Math.min(j + 8, batch.size()));
                    try {
                        List<String> got2 = gtx(micro);
                        if (got2.size() != micro.size()) throw new Exception("retry");
                        out.addAll(got2);
                    } catch (Exception e2) {
                        for (String t : micro) {
                            try {
                                List<String> one = gtx(java.util.Collections.singletonList(t));
                                out.add(one.isEmpty() || one.get(0).isEmpty() ? t : one.get(0));
                            } catch (Exception e3) {
                                out.add(t);
                            }
                            sleep(300);
                        }
                    }
                    sleep(400);
                }
            }
            sleep(500);
        }
        return out;
    }

    private static List<String> gtx(List<String> cues) throws Exception {
        StringBuilder qs = new StringBuilder("client=gtx&sl=en&tl=ar&dt=t");
        for (String t : cues) qs.append("&q=").append(URLEncoder.encode(t, "UTF-8"));
        String body = httpGet("https://translate.googleapis.com/translate_a/single?" + qs, null, null, 500000);
        JSONArray data = new JSONArray(body);
        JSONArray groups = data.optJSONArray(0);
        if (groups == null || groups.length() < cues.size()) throw new Exception("shape");
        List<String> out = new ArrayList<>();
        for (int i = 0; i < cues.size(); i++) {
            JSONArray g = groups.optJSONArray(i);
            if (g == null) throw new Exception("shape");
            // group = [[trans, orig, ...], ...] or flat [trans, orig, ...]
            JSONArray list = (g.length() > 0 && g.optJSONArray(0) != null) ? g : new JSONArray().put(g);
            StringBuilder sb = new StringBuilder();
            for (int k = 0; k < list.length(); k++) {
                JSONArray seg = list.optJSONArray(k);
                if (seg != null && seg.length() > 0 && !seg.isNull(0)) {
                    if (sb.length() > 0) sb.append(" ");
                    sb.append(seg.optString(0));
                }
            }
            out.add(sb.toString().trim());
        }
        return out;
    }

    private static String httpGet(String url, String ref, String range, int cap) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestProperty("User-Agent", StreamResolver.UA);
        if (ref != null) c.setRequestProperty("Referer", ref);
        c.setRequestProperty("Accept", "*/*");
        if (range != null) c.setRequestProperty("Range", range);
        c.setConnectTimeout(20000);
        c.setReadTimeout(25000);
        c.setInstanceFollowRedirects(true);
        int code = c.getResponseCode();
        if (code < 200 || code >= 300) throw new Exception("upstream " + code);
        InputStream in = c.getInputStream();
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n, total = 0;
        while ((n = in.read(buf)) > 0) {
            bos.write(buf, 0, n);
            total += n;
            if (total > cap) break;
        }
        in.close();
        return bos.toString("UTF-8");
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }

    private static String md5(String s) {
        try {
            MessageDigest d = MessageDigest.getInstance("MD5");
            byte[] h = d.digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : h) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return String.valueOf(s.hashCode());
        }
    }
}
