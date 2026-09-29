package com.moemen.tv;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;

/**
 * Moemen TV — Android TV shell.
 * Full-screen WebView running the bundled TV UI (assets/www), which fetches
 * live data from aniwaves.ru through the native ApiBridge (window.AniNeko).
 * Remote BACK is routed into the web UI so server switching / navigation
 * always works with a TV remote.
 */
public class MainActivity extends Activity {
    public static final int REQ_PLAYER = 1001;
    private WebView web;
    private View splash;
    private ProgressBar bar;
    private ApiBridge bridge;
    private boolean splashHidden = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        setTheme(R.style.AppTheme);
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyFullscreen();
        setContentView(R.layout.activity_main);

        web = findViewById(R.id.web);
        splash = findViewById(R.id.splash);
        bar = findViewById(R.id.loadbar);

        WebSettings st = web.getSettings();
        st.setJavaScriptEnabled(true);
        st.setDomStorageEnabled(true);
        st.setDatabaseEnabled(true);
        st.setMediaPlaybackRequiresUserGesture(false);
        st.setAllowFileAccess(true);
        st.setAllowContentAccess(true);
        st.setLoadsImagesAutomatically(true);
        st.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        st.setAllowUniversalAccessFromFileURLs(true);
        st.setAllowFileAccessFromFileURLs(true);
        st.setCacheMode(WebSettings.LOAD_DEFAULT);
        st.setUserAgentString(st.getUserAgentString() + " MoemenTV/1.0");

        bridge = new ApiBridge(this);
        StreamResolver.init(getCacheDir());
        web.addJavascriptInterface(bridge, "AniNeko");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                hideSplash();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                bar.setProgress(Math.max(progress, 10));
                if (progress >= 90) hideSplash();
            }
        });

        web.requestFocus(View.FOCUS_DOWN);
        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl("file:///android_asset/www/index.html");
        }
    }

    private void applyFullscreen() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
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

    private void hideSplash() {
        if (splashHidden) return;
        splashHidden = true;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                splash.animate().alpha(0f).setDuration(350)
                        .withEndAction(new Runnable() {
                            @Override
                            public void run() {
                                splash.setVisibility(View.GONE);
                            }
                        });
            }
        });
    }

    @Override
    public void onBackPressed() {
        // Route the remote BACK key into the web UI (close player, close search,
        // or go home). Only exits the app from the home screen.
        if (!splashHidden) return;
        if (bridge.playerOpen || bridge.searchOpen || !"home".equals(bridge.view)) {
            web.evaluateJavascript("window.__aninekoBack&&__aninekoBack()", null);
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        // Native player closed: push watch position back into the WebView UI
        if (requestCode == REQ_PLAYER && resultCode == RESULT_OK && data != null && web != null) {
            try {
                String slug = data.getStringExtra(PlayerActivity.EX_SLUG);
                int ep = data.getIntExtra(PlayerActivity.EX_EP, 1);
                long pos = data.getLongExtra("pos", 0);
                long dur = data.getLongExtra("dur", 0);
                String title = data.getStringExtra(PlayerActivity.EX_TITLE);
                String poster = data.getStringExtra(PlayerActivity.EX_POSTER);
                if (slug != null && !slug.isEmpty()) {
                    String js = "window.__aninekoProgress&&__aninekoProgress("
                            + org.json.JSONObject.quote(slug) + "," + ep + "," + pos + "," + dur + ","
                            + org.json.JSONObject.quote(title != null ? title : "") + ","
                            + org.json.JSONObject.quote(poster != null ? poster : "") + ")";
                    web.evaluateJavascript(js, null);
                }
            } catch (Exception ignored) { }
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
