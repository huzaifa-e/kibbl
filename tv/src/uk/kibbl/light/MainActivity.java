package uk.kibbl.light;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/*
 * kibbl. light on the TV: the backlight behind it, on and off, brightness, moods and effects,
 * with the remote's arrows and OK. It talks to the server's /api/tv/light with a token that
 * opens the light and nothing else (backend/src/routes/tv.ts), given once over adb:
 *   adb shell am start -n uk.kibbl.light/.MainActivity --es token kibbl_...
 */
public class MainActivity extends Activity {
    private static final String DEFAULT_SERVER = "https://kibbl.uk";
    private static final int POLL_MS = 3000;
    private static final int STEP = 10; // % per press of - and +

    // the night colours of the app
    private static final int BG = 0xff1c120d;
    private static final int CARD = 0xff2a1a12;
    private static final int ACCENT = 0xffd9622b;
    private static final int CREAM = 0xfff3e6cf;
    private static final int MUTED = 0xffa8917c;
    private static final int ERROR = 0xffe0654a;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private SharedPreferences prefs;

    private TextView name;
    private TextView status;
    private View swatch;
    private TextView power;
    private LinearLayout moods;
    private LinearLayout effects;
    private boolean built = false;
    private String lightId;
    private boolean lightOn = false;
    private int brightness = 60;
    private boolean polling = false;

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            if (!polling) return;
            load();
            main.postDelayed(this, POLL_MS);
        }
    };

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        prefs = getSharedPreferences("kibbl", MODE_PRIVATE);
        String token = getIntent().getStringExtra("token");
        String server = getIntent().getStringExtra("server");
        if (token != null && token.startsWith("kibbl_")) prefs.edit().putString("token", token).apply();
        if (server != null && server.startsWith("https://")) prefs.edit().putString("server", server).apply();
        setContentView(layout());
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (prefs.getString("token", null) == null) {
            status.setText("Not paired yet: the token is given once over adb (tv/build.sh install).");
            status.setTextColor(ERROR);
            return;
        }
        polling = true;
        main.post(poll);
    }

    @Override
    protected void onPause() {
        super.onPause();
        polling = false;
        main.removeCallbacks(poll);
    }

    /* ------------------------------------------------------------------- */

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return t;
    }

    private GradientDrawable rounded(int fill, int stroke) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(14));
        if (stroke != 0) g.setStroke(dp(3), stroke);
        return g;
    }

    // a button for the remote: lit in the accent colour while it has the focus
    private TextView button(String label, Integer dot, View.OnClickListener click) {
        TextView b = text(label, 18, CREAM, true);
        StateListDrawable bg = new StateListDrawable();
        bg.addState(new int[] {android.R.attr.state_focused}, rounded(ACCENT, CREAM));
        bg.addState(new int[] {}, rounded(CARD, 0));
        b.setBackground(bg);
        b.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        b.setPadding(dp(18), dp(12), dp(18), dp(12));
        b.setFocusable(true);
        b.setClickable(true);
        b.setOnClickListener(click);
        b.setOnFocusChangeListener((v, focused) -> v.animate().scaleX(focused ? 1.05f : 1f).scaleY(focused ? 1.05f : 1f).setDuration(120).start());
        if (dot != null) {
            GradientDrawable d = new GradientDrawable();
            d.setShape(GradientDrawable.OVAL);
            d.setColor(dot);
            d.setStroke(dp(1), CREAM);
            d.setSize(dp(16), dp(16));
            b.setCompoundDrawablesRelativeWithIntrinsicBounds(d, null, null, null);
            b.setCompoundDrawablePadding(dp(10));
        }
        return b;
    }

    private LinearLayout row() {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.bottomMargin = dp(12);
        r.setLayoutParams(p);
        return r;
    }

    private void addTo(LinearLayout r, View v, float weight) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, weight);
        p.rightMargin = dp(12);
        r.addView(v, p);
    }

    private View layout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(56), dp(36), dp(44), dp(36));

        LinearLayout head = row();
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = text("kibbl.", 30, CREAM, true);
        TextView sub = text("  light", 30, ACCENT, true);
        head.addView(title);
        head.addView(sub);
        name = text("", 20, MUTED, false);
        name.setPadding(dp(24), 0, 0, 0);
        head.addView(name);
        root.addView(head);

        LinearLayout state = row();
        state.setGravity(Gravity.CENTER_VERTICAL);
        swatch = new View(this);
        swatch.setBackground(rounded(CARD, CREAM));
        state.addView(swatch, new LinearLayout.LayoutParams(dp(36), dp(36)));
        status = text("Loading…", 20, CREAM, false);
        status.setPadding(dp(16), 0, 0, 0);
        state.addView(status);
        root.addView(state);

        LinearLayout controls = row();
        power = button("Turn on", null, v -> send("{\"on\":" + !lightOn + "}"));
        addTo(controls, power, 2);
        addTo(controls, button("Dimmer  −", null, v -> send("{\"brightness\":" + Math.max(1, brightness - STEP) + "}")), 2);
        addTo(controls, button("Brighter  +", null, v -> send("{\"brightness\":" + Math.min(100, brightness + STEP) + "}")), 2);
        addTo(controls, button("Stop effect", null, v -> send("{\"stop\":true}")), 2);
        root.addView(controls);

        root.addView(text("Moods", 16, MUTED, true));
        moods = new LinearLayout(this);
        moods.setOrientation(LinearLayout.VERTICAL);
        moods.setPadding(0, dp(8), 0, dp(8));
        root.addView(moods);

        root.addView(text("Effects", 16, MUTED, true));
        effects = new LinearLayout(this);
        effects.setOrientation(LinearLayout.VERTICAL);
        effects.setPadding(0, dp(8), 0, 0);
        root.addView(effects);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.addView(root);
        power.requestFocus();
        return scroll;
    }

    // the moods and effects the server offers, once
    private void build(JSONArray moodList, JSONArray effectList) {
        built = true;
        LinearLayout r = null;
        for (int i = 0; i < moodList.length(); i++) {
            JSONObject m = moodList.optJSONObject(i);
            if (i % 6 == 0) moods.addView(r = row());
            String id = m.optString("id");
            addTo(r, button(m.optString("label"), Color.parseColor(m.optString("color", "#ffffff")), v -> send("{\"mood\":\"" + id + "\"}")), 1);
        }
        for (int i = 0; i < effectList.length(); i++) {
            JSONObject e = effectList.optJSONObject(i);
            if (i % 4 == 0) effects.addView(r = row());
            String id = e.optString("id");
            // a sunrise from the TV wakes the room up in 20 minutes, a sunset sends it to sleep in 30
            String extra = id.equals("sunrise") ? ",\"minutes\":20" : id.equals("sunset") ? ",\"minutes\":30" : "";
            String label = e.optString("label") + (extra.isEmpty() ? "" : id.equals("sunrise") ? "  20 min" : "  30 min");
            addTo(r, button(label, null, v -> send("{\"effect\":\"" + id + "\"" + extra + "}")), 1);
        }
    }

    private void show(JSONObject light) {
        lightId = light.optString("id");
        lightOn = light.optBoolean("on");
        brightness = light.optInt("brightness", brightness);
        name.setText(light.optString("name"));
        String color = light.optString("color", "");
        String playing = light.isNull("playing") ? "" : "  ·  playing " + light.optString("playing");
        if (!light.optBoolean("online")) {
            status.setText("Offline");
            status.setTextColor(ERROR);
        } else {
            status.setText((lightOn ? "On  ·  " + brightness + " %" : "Off") + playing);
            status.setTextColor(CREAM);
        }
        int fill = CARD;
        try {
            if (lightOn && color.startsWith("#")) fill = Color.parseColor(color);
        } catch (IllegalArgumentException ignored) {
        }
        swatch.setBackground(rounded(fill, CREAM));
        power.setText(lightOn ? "Turn off" : "Turn on");
    }

    private void fail(String message) {
        status.setText(message);
        status.setTextColor(ERROR);
    }

    /* ------------------------------------------------------------------- */

    private void load() {
        net.execute(() -> {
            try {
                JSONObject r = new JSONObject(http("GET", "/api/tv/light", null));
                JSONArray lights = r.getJSONArray("lights");
                main.post(() -> {
                    if (!built) build(r.optJSONArray("moods"), r.optJSONArray("effects"));
                    if (lights.length() == 0) fail("No kibbl. light in this account.");
                    else show(lights.optJSONObject(0));
                });
            } catch (Exception e) {
                main.post(() -> fail(e.getMessage()));
            }
        });
    }

    private void send(String body) {
        if (lightId == null) return;
        String id = lightId;
        net.execute(() -> {
            try {
                JSONObject light = new JSONObject(http("POST", "/api/tv/light/" + id, body));
                main.post(() -> show(light));
            } catch (Exception e) {
                main.post(() -> fail(e.getMessage()));
            }
        });
    }

    private String http(String method, String path, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(prefs.getString("server", DEFAULT_SERVER) + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(8000);
        c.setReadTimeout(15000);
        c.setRequestProperty("Authorization", "Bearer " + prefs.getString("token", ""));
        c.setRequestProperty("Accept", "application/json");
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream o = c.getOutputStream()) {
                o.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        int code = c.getResponseCode();
        InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (in != null) {
            byte[] buf = new byte[4096];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            in.close();
        }
        String text = out.toString("UTF-8");
        if (code == 401) throw new Exception("The server does not take this TV's token any more: pair it again.");
        if (code >= 400) throw new Exception(text.isEmpty() ? "The server answered " + code : text);
        return text;
    }
}
