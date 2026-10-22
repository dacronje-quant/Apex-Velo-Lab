package com.apexvelo.lab.plugins

import android.app.Activity
import android.os.Bundle
import android.text.method.LinkMovementMethod
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.text.HtmlCompat
import com.apexvelo.lab.R

/**
 * What Health Connect shows when the rider taps "Read privacy policy" in its permission screen
 * (androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE, Android 13 and older) or in Settings > Apps >
 * Health Connect (android.intent.action.VIEW_PERMISSION_USAGE, Android 14+). Play requires this screen
 * for apps that ask for health permissions. It explains each data type in plain words and links the
 * full privacy policy.
 */
class HealthRationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = getString(R.string.health_rationale_title)
        val pad = (20 * resources.displayMetrics.density).toInt()
        val view = TextView(this).apply {
            setPadding(pad, pad, pad, pad)
            textSize = 16f
            text = HtmlCompat.fromHtml(getString(R.string.health_rationale_html, getString(R.string.privacy_policy_url)), HtmlCompat.FROM_HTML_MODE_COMPACT)
            movementMethod = LinkMovementMethod.getInstance()
        }
        setContentView(ScrollView(this).apply { addView(view) })
    }
}
