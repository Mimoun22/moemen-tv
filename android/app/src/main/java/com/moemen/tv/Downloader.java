package com.moemen.tv;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;

import androidx.core.app.NotificationCompat;
import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Background HLS episode downloader: resolves the embed, picks the requested
 * quality variant, concatenates TS segments into one playable .ts file plus an
 * .srt subtitle file, with progress + tap-to-play notifications.
 */
public class Downloader {
    private static final String CH = "moemen_downloads";
    private static final ExecutorService POOL = Executors.newFixedThreadPool(2);
    private static final AtomicInteger IDS = new AtomicInteger(1000);

    public static void enqueue(Context ctx, String json) {
        final Context app = ctx.getApplicationContext();
        POOL.execute(() -> run(app, json));
    }

    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CH) == null) {
            nm.createNotificationChannel(new NotificationChannel(CH, "Downloads", NotificationManager.IMPORTANCE_LOW));
        }
    }

    private static String safe(String s) {
        if (s == null) return "episode";
        return s.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
    }

    private static void run(Context ctx, String json) {
        StreamResolver.init(ctx.getCacheDir());
        ensureChannel(ctx);
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        int nid = IDS.incrementAndGet();
        String title = "Episode";
        try {
            JSONObject o = new JSONObject(json);
            String slug = o.optString("slug", "");
            int ep = o.optInt("ep", 1);
            title = o.optString("title", slug);
            String lang = o.optString("lang", "sub").toUpperCase(java.util.Locale.US);
            String embed = o.optString("embed", "");
            int quality = o.optInt("quality", 0);
            String subUrl = o.optString("subUrl", "");
            String baseName = safe(o.optString("name", title + " EP" + ep + " [" + lang + "]"));
            if (quality > 0 && !baseName.contains(quality + "p")) baseName += " [" + quality + "p]";

            notify(nm, ctx, nid, baseName, "Resolving source…", 0, 0, true, null);
            StreamResolver.Stream st = StreamResolver.resolve(embed);

            List<String> segs = new ArrayList<>();
            if (!"mp4".equals(st.type)) {
            List<StreamResolver.Variant> vars = StreamResolver.variants(st.file, st.referer);
            String playlist = st.file;
            StreamResolver.Variant pick = StreamResolver.pickVariant(vars, quality);
            if (pick != null) playlist = pick.url;
            String text = StreamResolver.readPlaylist(playlist, st.referer);
            if (text.contains("#EXT-X-STREAM-INF")) {
                // picked a master somehow: take first variant
                String[] lines = text.split("\n");
                for (int i = 0; i < lines.length; i++) {
                    if (lines[i].trim().startsWith("#EXT-X-STREAM-INF") && i + 1 < lines.length) {
                        String rel = lines[i + 1].trim();
                        if (!rel.isEmpty() && !rel.startsWith("#")) {
                            playlist = new URL(new URL(playlist), rel).toString();
                            break;
                        }
                    }
                }
                text = StreamResolver.readPlaylist(playlist, st.referer);
            }
            for (String l : text.split("\n")) {
                l = l.trim();
                if (!l.isEmpty() && !l.startsWith("#") && !l.startsWith("EXT-")) {
                    segs.add(StreamResolver.resolveSegmentUrl(l, playlist));
                }
            }
            if (segs.isEmpty()) throw new Exception("no segments");
            }

            File dir = new File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "MoemenTV");
            if (!dir.exists()) dir.mkdirs();
            File video;
            if ("mp4".equals(st.type)) {
                // direct file (my.1anime embeds): single GET with the play-page referer
                video = new File(dir, baseName + ".mp4");
                HttpURLConnection c = (HttpURLConnection) new URL(st.file).openConnection();
                c.setRequestProperty("User-Agent", StreamResolver.UA);
                c.setRequestProperty("Referer", st.referer);
                c.setConnectTimeout(20000);
                c.setReadTimeout(30000);
                c.setInstanceFollowRedirects(true);
                if (c.getResponseCode() / 100 != 2) throw new Exception("upstream " + c.getResponseCode());
                long total = c.getContentLengthLong();
                InputStream in = c.getInputStream();
                FileOutputStream fos = new FileOutputStream(video);
                byte[] buf = new byte[32768];
                int n;
                long done = 0;
                while ((n = in.read(buf)) > 0) {
                    fos.write(buf, 0, n);
                    done += n;
                    if (total > 0) {
                        int pct = (int) (done * 100 / total);
                        notify(nm, ctx, nid, baseName, "Downloading… " + pct + "%", 100, pct, true, null);
                    }
                }
                in.close();
                fos.close();
            } else {
            FileOutputStream fos = new FileOutputStream((video = new File(dir, baseName + ".ts")));
            byte[] buf = new byte[32768];
            for (int i = 0; i < segs.size(); i++) {
                HttpURLConnection c = (HttpURLConnection) new URL(segs.get(i)).openConnection();
                c.setRequestProperty("User-Agent", StreamResolver.UA);
                c.setRequestProperty("Referer", st.referer);
                c.setConnectTimeout(20000);
                c.setReadTimeout(30000);
                c.setInstanceFollowRedirects(true);
                if (c.getResponseCode() / 100 != 2) throw new Exception("segment " + c.getResponseCode());
                InputStream in = c.getInputStream();
                int n;
                while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
                in.close();
                int pct = (i + 1) * 100 / segs.size();
                notify(nm, ctx, nid, baseName, "Downloading… " + pct + "%", 100, pct, true, null);
            }
            fos.close();
            }

            // subtitle sidecar
            if (!subUrl.isEmpty()) {
                try {
                    String vtt = httpText(subUrl, "https://aniwaves.ru/");
                    File srt = new File(dir, baseName + ".srt");
                    FileOutputStream sfo = new FileOutputStream(srt);
                    sfo.write(toSrt(vtt).getBytes("UTF-8"));
                    sfo.close();
                } catch (Exception ignored) { }
            }

            MediaScannerConnection.scanFile(ctx, new String[]{video.getAbsolutePath()}, null, null);
            Intent open = new Intent(Intent.ACTION_VIEW);
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".files", video);
            open.setDataAndType(uri, "video/*");
            open.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent pi = PendingIntent.getActivity(ctx, nid, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
            notify(nm, ctx, nid, baseName, "Download complete — tap to play", 0, 0, false, pi);
        } catch (Exception e) {
            notify(nm, ctx, nid, title, "Download failed: " + e.getMessage(), 0, 0, false, null);
        }
    }

    private static String httpText(String url, String ref) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestProperty("User-Agent", StreamResolver.UA);
        c.setRequestProperty("Referer", ref);
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);
        if (c.getResponseCode() / 100 != 2) throw new Exception("upstream " + c.getResponseCode());
        InputStream in = c.getInputStream();
        String enc = c.getContentEncoding();
        if (enc != null && enc.contains("gzip")) in = new java.util.zip.GZIPInputStream(in);
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n, total = 0;
        while ((n = in.read(buf)) > 0) {
            bos.write(buf, 0, n);
            total += n;
            if (total > 6 * 1024 * 1024) break;
        }
        in.close();
        return bos.toString("UTF-8");
    }

    private static String toSrt(String vtt) {
        String[] blocks = vtt.replace("﻿", "").split("\r?\n\r?\n");
        StringBuilder out = new StringBuilder();
        int n = 0;
        for (String b : blocks) {
            String[] lines = b.split("\r?\n");
            List<String> keep = new ArrayList<>();
            for (String l : lines) {
                if (!l.trim().isEmpty()) keep.add(l);
            }
            if (keep.isEmpty() || keep.get(0).toUpperCase(java.util.Locale.US).startsWith("WEBVTT")) continue;
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
            out.append(++n).append("\n").append(keep.get(ti).trim().replace('.', ',')).append("\n").append(t).append("\n\n");
        }
        return out.toString();
    }

    private static void notify(NotificationManager nm, Context ctx, int id, String title,
                               String text, int max, int prog, boolean ongoing, PendingIntent pi) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CH)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(ongoing)
                .setAutoCancel(!ongoing)
                .setOnlyAlertOnce(true);
        if (max > 0) b.setProgress(max, prog, false);
        if (pi != null) b.setContentIntent(pi).setAutoCancel(true);
        try { nm.notify(id, b.build()); } catch (Exception ignored) { }
    }
}
