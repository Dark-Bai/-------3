package app.marketcockpit.tv;

import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.widget.Button;
import android.widget.EditText;

/** 深色控件样式: 系统默认控件是浅色, 电视上会露白底, 统一显式设为驾驶舱深色 */
final class Ui {
    static final int BG = Color.rgb(7, 11, 18);
    static final int PANEL = Color.rgb(15, 23, 42);
    static final int BORDER = Color.rgb(51, 65, 85);
    static final int TEXT = Color.rgb(226, 232, 240);
    static final int TEXT_DIM = Color.rgb(148, 163, 184);
    static final int ACCENT = Color.rgb(8, 145, 178);

    private Ui() {}

    private static GradientDrawable rounded(int fill, int stroke) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        d.setCornerRadius(12);
        d.setStroke(2, stroke);
        return d;
    }

    static void styleButton(Button b, boolean primary) {
        b.setBackground(rounded(primary ? ACCENT : PANEL, primary ? ACCENT : BORDER));
        b.setTextColor(Color.WHITE);
        b.setPadding(48, 16, 48, 16);
    }

    static void styleInput(EditText e) {
        e.setBackground(rounded(PANEL, BORDER));
        e.setTextColor(TEXT);
        e.setHintTextColor(TEXT_DIM);
        e.setPadding(32, 24, 32, 24);
    }
}
