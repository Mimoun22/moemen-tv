package com.moemen.tv;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.Tracks;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.ui.CaptionStyleCompat;
import androidx.media3.ui.PlayerView;
import androidx.media3.ui.SubtitleView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Own Netflix-style player (ExoPlayer): direct HLS, VTT subtitles, speed,
 * SUB/DUB switching, server cycling, prev/next episode, resume + auto-next.
 * Fully D-pad driven.
 */
public class PlayerActivity extends Activity {
    public static final String EX_SLUG = "slug";
    public static final String EX_EP = "ep";
    public static final String EX_TITLE = "title";
    public static final String EX_POSTER = "poster";
    public static final String EX_LANG = "lang";
    public static final String EX_SERVERS = "servers";
    public static final String EX_EPISODES = "episodes";
    public static final String EX_POS = "pos_ms";

    private static final float[] SPEEDS = {0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f};

    private PlayerView playerView;
    private View errorView;
    private TextView errorText;
    private ExoPlayer player;
    private final ExecutorService bg = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());

    private String slug, title, poster, lang;
    private int ep;
    private JSONObject servers;
    private final List<Integer> episodes = new ArrayList<>();
    private final List<JSONObject> subTracks = new ArrayList<>();
    private int srvIdx = 0;
    private int speedIdx = 2;
    private int subCycle = -2; // -2=auto(init), -1=off, else track index
    private boolean subExplicit = false; // user picked a subtitle option this episode
    private volatile boolean arabicPending = false;
    private boolean locked = false;
    private boolean dialogOpen = false;
    private Runnable endCountdown;
    private boolean resolving = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTheme(R.style.AppTheme);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        applyFullscreen();
        setContentView(R.layout.activity_player);

        slug = getIntent().getStringExtra(EX_SLUG);
        ep = getIntent().getIntExtra(EX_EP, 1);
        title = getIntent().getStringExtra(EX_TITLE);
        poster = getIntent().getStringExtra(EX_POSTER);
        lang = getIntent().getStringExtra(EX_LANG);
        try {
            servers = new JSONObject(getIntent().getStringExtra(EX_SERVERS));
            JSONArray eps = new JSONArray(getIntent().getStringExtra(EX_EPISODES));
            for (int i = 0; i < eps.length(); i++) episodes.add(eps.getInt(i));
        } catch (Exception e) {
            servers = new JSONObject();
        }
        if (title == null) title = slug;

        playerView = findViewById(R.id.player_view);
        errorView = findViewById(R.id.error_view);
        errorText = findViewById(R.id.error_text);

        player = new ExoPlayer.Builder(this)
                .setSeekBackIncrementMs(10000)
                .setSeekForwardIncrementMs(10000)
                .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED) onEnded();
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                onStreamError("Playback error: " + error.getMessage());
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                updatePlayIcon();
            }
            @Override
            public void onTracksChanged(Tracks tracks) {
                // default: subs on, except DUB which starts clean (opt-in via CC)
                if (!subExplicit) {
                    subCycle = "dub".equals(lang) ? -1 : firstTextTrack();
                }
                applySubSelection();
                updateSubsBtn();
            }
        });
        playerView.setPlayer(player);
        playerView.setControllerAutoShow(true);
        playerView.setControllerHideOnTouch(false);
        SubtitleView sv = playerView.getSubtitleView();
        if (sv != null) {
            sv.setStyle(new CaptionStyleCompat(Color.WHITE, 0xCC000000,
                    Color.BLACK, CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW,
                    Color.WHITE, Typeface.DEFAULT_BOLD));
            sv.setFractionalTextSize(0.055f, true);
        }

        StreamResolver.init(getCacheDir());
        wireControls();
        setTitleText();
        if (!hasLang(lang)) lang = firstLang();
        long startPos = getIntent().getLongExtra(EX_POS, 0);
        loadServer(0, startPos);
    }

    // ---------------- controls ----------------
    private void wireControls() {
        findViewById(R.id.btn_back).setOnClickListener(v -> finishWithReport());
        findViewById(R.id.btn_prev_ep).setOnClickListener(v -> playEpisode(ep - 1));
        findViewById(R.id.btn_next_ep).setOnClickListener(v -> playEpisode(ep + 1));
        findViewById(R.id.btn_speed).setOnClickListener(v -> openSpeedList());
        findViewById(R.id.btn_qual).setOnClickListener(v -> openQualityList());
        findViewById(R.id.btn_subs).setOnClickListener(v -> openSubsList());
        findViewById(R.id.btn_lang).setOnClickListener(v -> openLangList());
        findViewById(R.id.btn_server).setOnClickListener(v -> openServerList());
        findViewById(R.id.err_retry).setOnClickListener(v -> { hideError(); loadServer(0, resumePos()); });
        findViewById(R.id.err_server).setOnClickListener(v -> { hideError(); loadNextServer(); });
        findViewById(R.id.err_back).setOnClickListener(v -> finishWithReport());
        findViewById(R.id.btn_lock).setOnClickListener(v -> toggleLock());
        findViewById(R.id.lock_fab).setOnClickListener(v -> toggleLock());
        findViewById(R.id.btn_play).setOnClickListener(v -> {
            if (player != null) {
                player.setPlayWhenReady(!player.isPlaying());
                updatePlayIcon();
            }
        });
        playerView.requestFocus();
    }

    private String fmtSpeed(float s) {
        return (s == (int) s) ? ((int) s + "x") : (s + "x");
    }

    /** The one merged play/pause button. */
    private void updatePlayIcon() {
        android.widget.ImageButton b = findViewById(R.id.btn_play);
        if (b != null && player != null) {
            b.setImageResource(player.isPlaying() ? R.drawable.ic_pause : R.drawable.ic_play);
        }
    }

    /** Screen lock: every button disappears, only the lock remains. */
    private void toggleLock() {
        locked = !locked;
        playerView.setUseController(!locked);
        findViewById(R.id.lock_fab).setVisibility(locked ? View.VISIBLE : View.GONE);
        ((Button) findViewById(R.id.btn_lock)).setText(locked ? "🔓" : "🔒");
        if (locked) {
            findViewById(R.id.lock_fab).requestFocus();
            toast("Locked — Back to unlock");
        } else {
            playerView.showController();
        }
    }

    @Override
    public boolean dispatchKeyEvent(android.view.KeyEvent e) {
        if (e.getAction() == android.view.KeyEvent.ACTION_DOWN) {
            int kc = e.getKeyCode();
            // open pick-list dialogs get ALL keys untouched
            if (dialogOpen) return super.dispatchKeyEvent(e);
            if (locked) {
                // swallow everything except BACK (which unlocks via onBackPressed)
                return kc == android.view.KeyEvent.KEYCODE_BACK ? super.dispatchKeyEvent(e) : true;
            }
            boolean errShown = errorView.getVisibility() == View.VISIBLE;
            boolean controlsHidden = !playerView.isControllerFullyVisible() && !errShown;
            if (kc == android.view.KeyEvent.KEYCODE_DPAD_CENTER
                    || kc == android.view.KeyEvent.KEYCODE_NUMPAD_ENTER
                    || kc == android.view.KeyEvent.KEYCODE_ENTER
                    || kc == android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {
                if (!controlsHidden) return super.dispatchKeyEvent(e); // focused button handles it
                if (player != null) {
                    playerView.showController();
                    player.setPlayWhenReady(!player.getPlayWhenReady()); // pause works on FIRST press
                }
                return true;
            }
            if ((kc == android.view.KeyEvent.KEYCODE_DPAD_UP
                    || kc == android.view.KeyEvent.KEYCODE_DPAD_DOWN
                    || kc == android.view.KeyEvent.KEYCODE_DPAD_LEFT
                    || kc == android.view.KeyEvent.KEYCODE_DPAD_RIGHT) && controlsHidden) {
                playerView.showController();
                return true;
            }
        }
        return super.dispatchKeyEvent(e);
    }

    private void setTitleText() {
        ((TextView) findViewById(R.id.txt_title)).setText(title + " — EP " + ep);
    }

    // ---------------- loading ----------------
    private long resumePos() {
        return player != null ? Math.max(0, player.getCurrentPosition()) : 0;
    }

    private void loadServer(int idx, long keepPos) {
        if (resolving) return;
        List<Server> list = serversOf(lang);
        if (list.isEmpty()) { showError("No " + lang.toUpperCase() + " servers.", false); return; }
        srvIdx = Math.max(0, Math.min(idx, list.size() - 1));
        resolving = true;
        toast("Loading " + list.get(srvIdx).name + "…");
        bg.execute(() -> {
            Exception err = null;
            StreamResolver.Stream st = null;
            // try this server then the rest of the same language automatically
            for (int i = 0; i < list.size(); i++) {
                int at = (srvIdx + i) % list.size();
                try {
                    st = StreamResolver.resolve(list.get(at).embed);
                    srvIdx = at;
                    break;
                } catch (Exception e) {
                    err = e;
                }
            }
            final StreamResolver.Stream stream = st;
            final Exception failure = err;
            // DUB rarely ships captions: borrow the episode's English VTT so
            // English (and later Arabic) can be enabled on demand
            if (stream != null && stream.tracks.isEmpty()) {
                try {
                    String ev = StreamResolver.englishVttForServers(servers);
                    if (ev != null) stream.tracks.add(new StreamResolver.Track("English", ev));
                } catch (Exception ignored) { }
            }
            // session token: only attach Arabic if the user hasn't moved on
            final String fSlug = slug;
            final int fEp = ep, fSrv = srvIdx;
            final String fLang = lang;
            ui.post(() -> {
                resolving = false;
                if (stream != null) {
                    // start instantly — Arabic joins in the background when ready
                    applyStream(stream, keepPos, null);
                } else {
                    onStreamError("No working " + lang.toUpperCase() + " server"
                            + (failure != null ? ": " + failure.getMessage() : "."));
                }
            });
            // Background Arabic (never blocks playback start)
            if (stream != null) {
                arabicPending = true;
                String arPath = null;
                try {
                    String ev = StreamResolver.englishVttForServers(servers);
                    if (ev != null) arPath = ArabicSub.get(PlayerActivity.this, ev);
                } catch (Exception ignored) { }
                arabicPending = false;
                final String arabicPath = arPath;
                if (arabicPath != null) {
                    ui.post(() -> {
                        if (player == null) return;
                        if (!fSlug.equals(slug) || fEp != ep || fSrv != srvIdx || !fLang.equals(lang)) return;
                        addArabicTrack(arabicPath);
                    });
                }
            }
        });
    }

    private String currentUri = "";
    private String currentReferer = "";
    private String currentType = "hls";
    private final List<MediaItem.SubtitleConfiguration> currentSubs = new ArrayList<>();

    private MediaSource buildSource(androidx.media3.datasource.DataSource.Factory ds, MediaItem item, String type) {
        if ("mp4".equals(type)) {
            return new androidx.media3.exoplayer.source.ProgressiveMediaSource.Factory(ds)
                    .createMediaSource(item);
        }
        return new HlsMediaSource.Factory(ds).createMediaSource(item);
    }

    private void applyStream(StreamResolver.Stream st, long keepPos, String arabicPath) {
        hideError();
        subTracks.clear();
        List<MediaItem.SubtitleConfiguration> subs = new ArrayList<>();
        for (int i = 0; i < st.tracks.size(); i++) {
            StreamResolver.Track t = st.tracks.get(i);
            subTracks.add(new JSONObject());
            subs.add(new MediaItem.SubtitleConfiguration.Builder(android.net.Uri.parse(t.file))
                    .setMimeType(MimeTypes.TEXT_VTT)
                    .setLanguage("en")
                    .setLabel(t.label != null ? t.label : "English")
                    .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                    .build());
        }
        if (arabicPath != null) {
            subs.add(new MediaItem.SubtitleConfiguration.Builder(android.net.Uri.fromFile(new java.io.File(arabicPath)))
                    .setMimeType(MimeTypes.TEXT_VTT)
                    .setLanguage("ar")
                    .setLabel("العربية")
                    .build());
        }
        subCycle = -2;
        qualLabel = "Auto";
        ((Button) findViewById(R.id.btn_qual)).setText("Auto");
        currentUri = st.file;
        currentReferer = st.referer;
        currentType = st.type != null ? st.type : "hls";
        currentSubs.clear();
        currentSubs.addAll(subs);
        MediaItem item = new MediaItem.Builder()
                .setUri(st.file)
                .setSubtitleConfigurations(subs)
                .build();
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent(StreamResolver.UA)
                .setDefaultRequestProperties(Collections.singletonMap("Referer", st.referer));
        // scheme-aware: http(s) segments via Http, local file:// subs via File
        androidx.media3.datasource.DataSource.Factory ds =
                new androidx.media3.datasource.DefaultDataSource.Factory(this, http);
        MediaSource src = buildSource(ds, item, currentType);
        player.setMediaSource(src);
        player.prepare();
        if (keepPos > 10000) player.seekTo(keepPos);
        player.play();
        updateServerBtn();
        updateLangBtn();
    }

    /** Attach the Arabic track to the running stream without losing position. */
    private void addArabicTrack(String path) {
        try {
            if (player == null || currentUri.isEmpty()) return;
            for (MediaItem.SubtitleConfiguration sc : currentSubs) {
                if ("ar".equals(sc.language)) return;
            }
            MediaItem.SubtitleConfiguration ar =
                    new MediaItem.SubtitleConfiguration.Builder(android.net.Uri.fromFile(new java.io.File(path)))
                            .setMimeType(MimeTypes.TEXT_VTT)
                            .setLanguage("ar")
                            .setLabel("العربية")
                            .build();
            currentSubs.add(ar);
            MediaItem item = new MediaItem.Builder()
                    .setUri(currentUri)
                    .setSubtitleConfigurations(new ArrayList<>(currentSubs))
                    .build();
            DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                    .setUserAgent(StreamResolver.UA)
                    .setDefaultRequestProperties(Collections.singletonMap("Referer", currentReferer));
            androidx.media3.datasource.DataSource.Factory ds =
                    new androidx.media3.datasource.DefaultDataSource.Factory(this, http);
            MediaSource src = buildSource(ds, item, currentType);
            long pos = Math.max(0, player.getCurrentPosition());
            player.setMediaSource(src, pos);
            player.prepare();
            // only announce once the track is actually listed (no more lying toasts)
            ui.postDelayed(() -> {
                if (player == null) return;
                if (hasArabicTrack()) toast("العربية subtitles ready");
                else {
                    // one retry: rebuild once more in case the prepare raced
                    try {
                        long p2 = Math.max(0, player.getCurrentPosition());
                        player.setMediaSource(src, p2);
                        player.prepare();
                        ui.postDelayed(() -> { if (hasArabicTrack()) toast("العربية subtitles ready"); }, 2500);
                    } catch (Exception ignored) { }
                }
            }, 2500);
        } catch (Exception ignored) { }
    }

    private boolean hasArabicTrack() {
        try {
            for (int i = 0; i < player.getCurrentTracks().getGroups().size(); i++) {
                Tracks.Group g = player.getCurrentTracks().getGroups().get(i);
                if (g.getType() != C.TRACK_TYPE_TEXT) continue;
                for (int t = 0; t < g.length; t++) {
                    CharSequence label = g.getTrackFormat(t).label;
                    if (label != null && label.toString().contains("العربية")) return true;
                }
            }
        } catch (Exception ignored) { }
        return false;
    }

    private void onStreamError(String msg) {
        showError(msg + "\nAll " + (lang != null ? lang.toUpperCase() : "") + " servers exhausted.", true);
    }

    // ---------------- server / lang / subs cycling ----------------
    private static class Server {
        String name, embed;
    }

    private List<Server> serversOf(String l) {
        List<Server> out = new ArrayList<>();
        if (servers == null || l == null) return out;
        JSONArray arr = servers.optJSONArray(l);
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            Server s = new Server();
            s.name = o.optString("name", "Server " + (i + 1));
            s.embed = o.optString("embed", "");
            // Aniwatch names (VidSrc, HD-1, …) all resolve through MegaPlay — no exclusions.
            if (!s.embed.isEmpty()) out.add(s);
        }
        return out;
    }

    private boolean hasLang(String l) {
        return l != null && !serversOf(l).isEmpty();
    }

    private String firstLang() {
        // default: DUB if available, else HSUB, else SUB
        for (String l : new String[]{"dub", "hsub", "sub"}) {
            if (!serversOf(l).isEmpty()) return l;
        }
        return "dub";
    }

    // ---------------- pick-lists (no tap-to-cycle: choose directly) ----------------
    private interface PickHandler { void pick(int which); }

    private void showList(String title, String[] items, int checked, PickHandler onPick) {
        runOnUiThread(() -> {
            android.app.AlertDialog.Builder b = new android.app.AlertDialog.Builder(
                    PlayerActivity.this, android.R.style.Theme_Material_Dialog_Alert);
            b.setTitle(title);
            b.setSingleChoiceItems(items, checked, (d, which) -> { d.dismiss(); onPick.pick(which); });
            b.setNegativeButton("Cancel", null);
            android.app.AlertDialog dlg = b.create();
            // track visibility: the DPAD interceptor below must NOT swallow
            // keys meant for open dialogs (server/lang/subs/speed/quality lists)
            dlg.setOnShowListener(d -> dialogOpen = true);
            dlg.setOnDismissListener(d -> dialogOpen = false);
            dlg.show();
        });
    }

    private void openSpeedList() {
        String[] items = new String[SPEEDS.length];
        for (int i = 0; i < SPEEDS.length; i++) items[i] = fmtSpeed(SPEEDS[i]);
        showList("Playback speed", items, speedIdx, which -> {
            speedIdx = which;
            player.setPlaybackSpeed(SPEEDS[which]);
            ((Button) findViewById(R.id.btn_speed)).setText(fmtSpeed(SPEEDS[which]));
        });
    }

    private void openSubsList() {
        List<String> labels = new ArrayList<>();
        final List<Integer> pickIdx = new ArrayList<>();
        labels.add("Off");
        pickIdx.add(-1);
        for (int i = 0; i < textTrackCount(); i++) {
            labels.add(trackLabel(i));
            pickIdx.add(i);
        }
        if (arabicPending && !hasArabicTrack()) {
            labels.add("العربية (loading…)");
            pickIdx.add(-2); // not selectable yet
        }
        if (labels.size() == 1) { toast("No subtitles for this episode"); return; }
        final boolean[] dismissed = {false};
        showList("Subtitles", labels.toArray(new String[0]), subCycle + 1, which -> {
            if (dismissed[0]) return;
            dismissed[0] = true;
            int mapped = pickIdx.get(which);
            if (mapped == -2) { toast("العربية is still loading…"); openSubsList(); return; }
            subCycle = mapped;
            subExplicit = true;
            applySubSelection();
            toast(subCycle < 0 ? "Subtitles off" : "Subtitles: " + labels.get(which));
        });
    }

    private void openLangList() {
        List<String> av = new ArrayList<>();
        for (String l : new String[]{"dub", "hsub", "sub"}) {
            if (!serversOf(l).isEmpty()) av.add(l.toUpperCase());
        }
        if (av.size() < 2) { toast("Only " + (av.isEmpty() ? "—" : av.get(0))); return; }
        final List<String> langs = new ArrayList<>();
        for (String l : new String[]{"dub", "hsub", "sub"}) {
            if (!serversOf(l).isEmpty()) langs.add(l);
        }
        showList("Audio", av.toArray(new String[0]), langs.indexOf(lang), which -> {
            lang = langs.get(which);
            updateLangBtn();
            loadServer(0, resumePos());
        });
    }

    private String qualLabel = "Auto";

    private static class VideoOpt {
        Tracks.Group group; int index; String label;
    }

    private List<VideoOpt> videoOpts() {
        List<VideoOpt> out = new ArrayList<>();
        for (int i = 0; i < player.getCurrentTracks().getGroups().size(); i++) {
            Tracks.Group g = player.getCurrentTracks().getGroups().get(i);
            if (g.getType() != C.TRACK_TYPE_VIDEO) continue;
            for (int t = 0; t < g.length; t++) {
                Format f = g.getTrackFormat(t);
                VideoOpt o = new VideoOpt();
                o.group = g; o.index = t;
                o.label = f.height > 0 ? (f.height + "p")
                        : (f.bitrate > 0 ? ((f.bitrate / 1000) + " kbps") : ("Q" + (out.size() + 1)));
                // de-dupe identical labels, keep highest bitrate
                boolean dup = false;
                for (VideoOpt e : out) {
                    if (e.label.equals(o.label)) { dup = true; break; }
                }
                if (!dup) out.add(o);
            }
        }
        return out;
    }

    private void openQualityList() {
        List<VideoOpt> opts = videoOpts();
        if (opts.isEmpty()) { toast("Quality: auto only for this stream"); return; }
        String[] items = new String[opts.size() + 1];
        items[0] = "Auto";
        for (int i = 0; i < opts.size(); i++) items[i + 1] = opts.get(i).label;
        int checked = 0;
        for (int i = 0; i < opts.size(); i++) {
            if (opts.get(i).label.equals(qualLabel)) { checked = i + 1; break; }
        }
        showList("Quality", items, checked, which -> {
            TrackSelectionParameters.Builder b = new TrackSelectionParameters.Builder(this);
            b.clearOverridesOfType(C.TRACK_TYPE_VIDEO);
            if (which == 0) {
                qualLabel = "Auto";
            } else {
                VideoOpt o = opts.get(which - 1);
                b.addOverride(new TrackSelectionOverride(o.group.getMediaTrackGroup(), o.index));
                qualLabel = o.label;
            }
            player.setTrackSelectionParameters(b.build());
            ((Button) findViewById(R.id.btn_qual)).setText(qualLabel);
            toast("Quality: " + qualLabel);
        });
    }

    private void openServerList() {        List<Server> list = serversOf(lang);
        if (list.size() < 2) { toast("Only one " + lang.toUpperCase() + " server"); return; }
        String[] items = new String[list.size()];
        for (int i = 0; i < list.size(); i++) items[i] = (i + 1) + ". " + list.get(i).name;
        showList(lang.toUpperCase() + " servers", items, srvIdx, which ->
                loadServer(which, resumePos()));
    }

    private void loadNextServer() {
        List<Server> list = serversOf(lang);
        if (list.isEmpty()) return;
        loadServer((srvIdx + 1) % list.size(), resumePos());
    }

    private void updateServerBtn() {
        List<Server> list = serversOf(lang);
        String n = list.isEmpty() ? "Server" : list.get(Math.min(srvIdx, list.size() - 1)).name;
        ((Button) findViewById(R.id.btn_server)).setText("▦ " + n);
    }

    private void updateLangBtn() {
        ((Button) findViewById(R.id.btn_lang)).setText(lang != null ? lang.toUpperCase() : "SUB");
    }

    // ---- subtitle cycling (off -> track1 -> track2 ...) ----
    private List<Tracks.Group> textGroups() {
        List<Tracks.Group> out = new ArrayList<>();
        for (int i = 0; i < player.getCurrentTracks().getGroups().size(); i++) {
            Tracks.Group g = player.getCurrentTracks().getGroups().get(i);
            if (g.getType() == C.TRACK_TYPE_TEXT && g.length > 0) out.add(g);
        }
        return out;
    }

    private int textTrackCount() {
        int n = 0;
        for (Tracks.Group g : textGroups()) n += g.length;
        return n;
    }

    private int firstTextTrack() {
        return textTrackCount() > 0 ? 0 : -1;
    }

    private void applySubSelection() {
        TrackSelectionParameters.Builder b = new TrackSelectionParameters.Builder(this);
        if (subCycle < 0) {
            b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true);
        } else {
            b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false);
            b.clearOverridesOfType(C.TRACK_TYPE_TEXT);
            int at = subCycle;
            for (Tracks.Group g : textGroups()) {
                if (at < g.length) {
                    b.addOverride(new TrackSelectionOverride(g.getMediaTrackGroup(), at));
                    break;
                }
                at -= g.length;
            }
        }
        player.setTrackSelectionParameters(b.build());
        updateSubsBtn();
    }

    private String trackLabel(int idx) {
        for (Tracks.Group g : textGroups()) {
            if (idx < g.length) {
                Format f = g.getTrackFormat(idx);
                return f.label != null ? f.label : ("Track " + (idx + 1));
            }
            idx -= g.length;
        }
        return "Track";
    }

    private void updateSubsBtn() {
        Button b = findViewById(R.id.btn_subs);
        if (b == null) return;
        int n = textTrackCount();
        b.setText(n == 0 ? "CC ✕" : (subCycle < 0 ? "CC off" : "CC ✓"));
    }

    // ---------------- episodes ----------------
    private void playEpisode(int nextEp) {
        if (nextEp < 1) { toast("This is the first episode"); return; }
        if (!episodes.isEmpty() && !episodes.contains(nextEp)) { toast("Episode " + nextEp + " not available"); return; }
        bg.execute(() -> {
            try {
                ApiBridge bridge = new ApiBridge();
                JSONObject w = bridge.getWatch(slug, nextEp);
                JSONObject srv = w.optJSONObject("servers");
                if (srv == null) throw new Exception("no servers");
                ui.post(() -> {
                    ep = nextEp;
                    servers = srv;
                    subExplicit = false;
                    arabicPending = false;
                    if (!hasLang(lang)) lang = firstLang();
                    setTitleText();
                    loadServer(0, 0);
                });
            } catch (Exception e) {
                ui.post(() -> toast("Couldn't load EP " + nextEp));
            }
        });
    }

    private void onEnded() {
        int next = ep + 1;
        if (!episodes.isEmpty() && !episodes.contains(next)) {
            showEndCard("Thanks for watching", title, "Back", this::finishWithReport, null, null);
            return;
        }
        final int[] n = {10};
        showEndCard("Up next: Episode " + next, "Starting soon — OK plays now, Back cancels",
                "▶ Play now", () -> { cancelEndTimer(); playEpisode(next); },
                "✕ Cancel", () -> { cancelEndTimer(); hideError(); });
        ui.post(new Runnable() {
            @Override
            public void run() {
                // wired via err buttons; countdown handled below
            }
        });
        cancelEndTimer();
        endCountdown = new Runnable() {
            @Override
            public void run() {
                n[0]--;
                TextView t = findViewById(R.id.error_text);
                if (t != null && errorView.getVisibility() == View.VISIBLE) {
                    if (n[0] <= 0) { playEpisode(next); return; }
                    t.setText("Starting in " + n[0] + "s — OK plays now, Back cancels");
                    ui.postDelayed(this, 1000);
                }
            }
        };
        ui.postDelayed(endCountdown, 1000);
        Button now = findViewById(R.id.err_retry);
        if (now != null) now.requestFocus();
    }

    private void cancelEndTimer() {
        if (endCountdown != null) ui.removeCallbacks(endCountdown);
        endCountdown = null;
    }

    // ---------------- error / end cards ----------------
    private void showError(String msg, boolean canRetry) {
        errorText.setText(msg);
        findViewById(R.id.err_retry).setVisibility(canRetry ? View.VISIBLE : View.GONE);
        findViewById(R.id.err_server).setVisibility(canRetry ? View.VISIBLE : View.GONE);
        ((Button) findViewById(R.id.err_retry)).setText("↻ Retry");
        ((Button) findViewById(R.id.err_server)).setText("▦ Next server");
        errorView.setVisibility(View.VISIBLE);
        findViewById(R.id.err_retry).requestFocus();
    }

    private void showEndCard(String title, String msg, String yes, Runnable onYes, String no, Runnable onNo) {
        errorText.setText(title + "\n" + msg);
        Button r = findViewById(R.id.err_retry);
        Button s = findViewById(R.id.err_server);
        Button b = findViewById(R.id.err_back);
        r.setText(yes);
        r.setVisibility(View.VISIBLE);
        r.setOnClickListener(v -> onYes.run());
        if (no != null) {
            s.setText(no);
            s.setVisibility(View.VISIBLE);
            s.setOnClickListener(v -> onNo.run());
        } else {
            s.setVisibility(View.GONE);
        }
        b.setText("← Back");
        errorView.setVisibility(View.VISIBLE);
        r.requestFocus();
    }

    private void hideError() {
        cancelEndTimer();
        errorView.setVisibility(View.GONE);
        // restore default error-button wiring
        findViewById(R.id.err_retry).setOnClickListener(v -> { hideError(); loadServer(0, resumePos()); });
        findViewById(R.id.err_server).setOnClickListener(v -> { hideError(); loadNextServer(); });
        ((Button) findViewById(R.id.err_retry)).setText("↻ Retry");
        ((Button) findViewById(R.id.err_server)).setText("▦ Next server");
    }

    // ---------------- lifecycle ----------------
    private void toast(String m) {
        runOnUiThread(() -> Toast.makeText(PlayerActivity.this, m, Toast.LENGTH_SHORT).show());
    }

    private void applyFullscreen() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyFullscreen();
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (player != null) player.pause();
    }

    @Override
    public void onBackPressed() {
        if (locked) { toggleLock(); return; }
        if (errorView.getVisibility() == View.VISIBLE && endCountdown != null) {
            cancelEndTimer();
            hideError();
            return;
        }
        finishWithReport();
    }

    private void finishWithReport() {
        try {
            long pos = player != null ? Math.max(0, player.getCurrentPosition()) : 0;
            long dur = player != null ? Math.max(0, player.getDuration()) : 0;
            if (dur < 0) dur = 0;
            android.content.Intent data = new android.content.Intent();
            data.putExtra(EX_SLUG, slug);
            data.putExtra(EX_EP, ep);
            data.putExtra("pos", pos / 1000);
            data.putExtra("dur", dur > 0 && dur != C.TIME_UNSET ? dur / 1000 : 0);
            data.putExtra(EX_TITLE, title);
            data.putExtra(EX_POSTER, poster);
            setResult(RESULT_OK, data);
        } catch (Exception ignored) { }
        finish();
    }

    @Override
    protected void onDestroy() {
        cancelEndTimer();
        bg.shutdownNow();
        if (playerView != null) playerView.setPlayer(null);
        if (player != null) player.release();
        super.onDestroy();
    }
}
