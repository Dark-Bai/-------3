package app.marketcockpit.tv;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/** 服务器地址设置: 首次启动或遥控器菜单键进入, 保存后启动主界面 */
public class SettingsActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences prefs = getSharedPreferences("tv", MODE_PRIVATE);

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setPadding(96, 96, 96, 96);
        layout.setBackgroundColor(Ui.BG);

        TextView title = new TextView(this);
        title.setText("驾驶舱服务器地址");
        title.setTextColor(Ui.TEXT);
        title.setTextSize(22);
        title.setGravity(Gravity.CENTER);
        layout.addView(title);

        TextView hint = new TextView(this);
        hint.setText("\n默认为公网部署地址，也可改为局域网地址（电脑端 npm start 后填 http://<电脑IP>:3000）\n");
        hint.setTextColor(Ui.TEXT_DIM);
        hint.setTextSize(14);
        hint.setGravity(Gravity.CENTER);
        layout.addView(hint);

        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setText(prefs.getString("server_url", MainActivity.DEFAULT_URL));
        input.setHint(MainActivity.DEFAULT_URL);
        Ui.styleInput(input);
        layout.addView(input);

        Button save = new Button(this);
        save.setText("保存并进入驾驶舱");
        Ui.styleButton(save, true);
        save.setOnClickListener(v -> {
            String url = input.getText().toString().trim();
            if (url.endsWith("/")) url = url.substring(0, url.length() - 1);
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                Toast.makeText(this, "地址需以 http:// 或 https:// 开头", Toast.LENGTH_LONG).show();
                return;
            }
            prefs.edit().putString("server_url", url).apply();
            startActivity(new Intent(this, MainActivity.class));
            finish();
        });
        LinearLayout.LayoutParams saveLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        saveLp.topMargin = 32;
        saveLp.gravity = Gravity.CENTER_HORIZONTAL;
        layout.addView(save, saveLp);

        setContentView(layout);
        input.requestFocus();
    }
}
