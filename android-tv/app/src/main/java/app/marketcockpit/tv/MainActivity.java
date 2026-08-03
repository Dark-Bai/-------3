package app.marketcockpit.tv;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 全屏 WebView 壳: 加载驾驶舱 Web 端(自动拼 ?tv=1 启用遥控器空间导航)。
 * 方向键/OK 由 WebView 透传给网页; 返回键 = 还原已放大面板 → 历史后退 → 退出; 菜单键 = 服务器设置。
 */
public class MainActivity extends Activity {

    /** 默认服务器(公网部署), 可在设置页(menu 键)修改 */
    static final String DEFAULT_URL = "https://mrd.hermes.cc.cd";

    private WebView web;
    private String serverUrl;
    private android.widget.FrameLayout root;
    private View splash;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        serverUrl = prefs().getString("server_url", DEFAULT_URL);
        showDashboard();
    }

    private SharedPreferences prefs() {
        return getSharedPreferences("tv", MODE_PRIVATE);
    }

    private void showDashboard() {
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // 自选股 localStorage 持久化
        s.setTextZoom(100);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        // 提高 WebView 渲染进程优先级, 降低电视弱 GPU 下被系统降级的概率
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        }
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                dismissSplash();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError();
            }
        });
        // 开屏页盖在 WebView 上, 页面加载完成后淡出
        root = new android.widget.FrameLayout(this);
        root.addView(web, new android.widget.FrameLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT));
        splash = buildSplash();
        root.addView(splash);
        setContentView(root);
        // WebView 默认白底, 加载中与页面空隙会露白, 强制深色
        web.setBackgroundColor(Ui.BG);
        // 强制硬件加速: 部分电视盒子对 WebView 回落到软件渲染, 4K 下FPS只有个位数
        getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        // 页面在 TV 模式固定 1920 CSS px 视口, 按屏幕实际 dp 宽度算出恰好铺满的缩放
        // (高密度 4K 电视上报 960dp 时缩到 50%, 1080p 电视 100%)
        float widthDp = getResources().getDisplayMetrics().widthPixels
                / getResources().getDisplayMetrics().density;
        web.setInitialScale(Math.round(100f * widthDp / 1920f));
        web.loadUrl(withTvParam(serverUrl));
    }

    private String withTvParam(String url) {
        return Uri.parse(url).buildUpon().appendQueryParameter("tv", "1").build().toString();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** 开屏页: Logo 呼吸动画 + 应用名 + 加载进度, 避免加载期黑屏干等 */
    private View buildSplash() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setBackgroundColor(Ui.BG);

        android.widget.ImageView logo = new android.widget.ImageView(this);
        logo.setImageResource(R.drawable.ic_launcher);
        LinearLayout.LayoutParams logoLp = new LinearLayout.LayoutParams(dp(96), dp(96));
        layout.addView(logo, logoLp);
        // 呼吸缩放动画
        android.animation.ObjectAnimator pulse = android.animation.ObjectAnimator.ofPropertyValuesHolder(
                logo,
                android.animation.PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 1.12f),
                android.animation.PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 1.12f));
        pulse.setDuration(800);
        pulse.setRepeatCount(android.animation.ObjectAnimator.INFINITE);
        pulse.setRepeatMode(android.animation.ObjectAnimator.REVERSE);
        pulse.start();

        TextView name = new TextView(this);
        name.setText("市场研究驾驶舱");
        name.setTextColor(Ui.TEXT);
        name.setTextSize(30);
        name.setGravity(Gravity.CENTER);
        name.setPadding(0, dp(24), 0, 0);
        layout.addView(name);

        TextView sub = new TextView(this);
        sub.setText("MARKET RESEARCH COCKPIT");
        sub.setTextColor(Ui.ACCENT);
        sub.setTextSize(13);
        sub.setLetterSpacing(0.3f);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, dp(8), 0, 0);
        layout.addView(sub);

        android.widget.ProgressBar bar = new android.widget.ProgressBar(this);
        bar.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(Ui.ACCENT));
        LinearLayout.LayoutParams barLp = new LinearLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT);
        barLp.topMargin = dp(32);
        layout.addView(bar, barLp);

        TextView hint = new TextView(this);
        hint.setText("正在连接 " + Uri.parse(serverUrl).getHost() + " …");
        hint.setTextColor(Ui.TEXT_DIM);
        hint.setTextSize(13);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, dp(16), 0, 0);
        layout.addView(hint);

        return layout;
    }

    /** 页面加载完成: 开屏页淡出后移除 */
    private void dismissSplash() {
        if (splash == null || root == null) return;
        final View s = splash;
        splash = null;
        s.animate().alpha(0f).setDuration(450).withEndAction(() -> root.removeView(s)).start();
    }

    /** 连接失败: 原生兜底页, 避免白屏 */
    private void showError() {
        dismissSplash();
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setPadding(64, 64, 64, 64);
        layout.setBackgroundColor(Ui.BG);

        TextView msg = new TextView(this);
        msg.setText("无法连接服务器\n" + serverUrl + "\n\n请确认服务器可访问，或修改服务器地址");
        msg.setTextColor(Ui.TEXT);
        msg.setTextSize(18);
        msg.setGravity(Gravity.CENTER);
        msg.setPadding(0, 0, 0, 32);
        layout.addView(msg);

        Button retry = new Button(this);
        retry.setText("重试");
        Ui.styleButton(retry, true);
        retry.setOnClickListener(v -> showDashboard());
        layout.addView(retry);

        Button settings = new Button(this);
        settings.setText("修改服务器地址");
        Ui.styleButton(settings, false);
        settings.setOnClickListener(v -> {
            startActivity(new Intent(this, SettingsActivity.class));
            finish();
        });
        layout.addView(settings);

        setContentView(layout);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SETTINGS) {
            startActivity(new Intent(this, SettingsActivity.class));
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null) {
            // 先还原已放大的面板(data-tv-zoomed), 再退历史, 最后退出
            web.evaluateJavascript(
                    "(function(){var z=document.querySelector('[data-tv-zoomed]');if(z){z.click();return 1;}return 0;})()",
                    value -> {
                        if (!"1".equals(value)) {
                            if (web.canGoBack()) web.goBack();
                            else finish();
                        }
                    });
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
