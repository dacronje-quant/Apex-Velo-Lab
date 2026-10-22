package com.apexvelo.lab;

import android.os.Bundle;
import com.apexvelo.lab.plugins.HealthConnectPlugin;
import com.apexvelo.lab.plugins.ApexImportPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins are registered before the bridge starts in super.onCreate.
        registerPlugin(ApexImportPlugin.class);
        registerPlugin(HealthConnectPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
