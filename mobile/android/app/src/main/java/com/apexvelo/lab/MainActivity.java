package com.apexvelo.lab;

import android.os.Bundle;
import com.apexvelo.lab.plugins.HealthConnectPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins (src/main/java/com/apexvelo/lab/plugins), registered before the bridge starts.
        registerPlugin(HealthConnectPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
