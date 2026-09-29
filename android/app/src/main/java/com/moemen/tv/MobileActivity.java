package com.moemen.tv;

import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;

/**
 * Moemen TV — phone shell (portrait, touch).
 * Same WebView UI with mobile CSS; the bridge runs in phone mode
 * (downloads visible, native downloader enabled).
 */
public class MobileActivity extends Activity {
    public static final int REQ_PLAYER = 1002;
    private WebView web;
    private View splash;
    private ProgressBar bar;
    private ApiBridge bridge;
    private boolean splashHidden = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        setTheme(R.style.MobileTheme);
        super.onCreate(savedInstanceState);
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

        bridge = new ApiBridge(this, false);
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

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl("file:///android_asset/www/index.html");
        }

        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 41);
        }
    }

    private void hideSplash() {
        if (splashHidden) return;
        splashHidden = true;
        runOnUiThread(() -> splash.animate().alpha(0f).setDuration(350)
                .withEndAction(() -> splash.setVisibility(View.GONE)));
    }

    @Override
    public void onBackPressed() {
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
