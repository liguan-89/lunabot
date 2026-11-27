package com.lunabot.companion.ui

import android.app.Activity
import android.os.Bundle
import android.widget.FrameLayout

class ChatAppTestActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(FrameLayout(this))
    }
}
