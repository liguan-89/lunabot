package com.lunabot.companion.phoneui

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The controlled display the task executor holds right now, published so the
 * watch entry and the floating view can read its frames. The executor is the
 * only writer: attach on creation, detach on every close path, so a watching
 * surface never keeps a released display. Detach is a compare-and-set because
 * a replacement session may already be attached when the old one is dropped.
 */
internal object PhoneUiMirror {
    private val _display = MutableStateFlow<PhoneUiDisplaySession?>(null)
    val display: StateFlow<PhoneUiDisplaySession?> = _display.asStateFlow()

    fun attach(session: PhoneUiDisplaySession) {
        _display.value = session
    }

    fun detach(session: PhoneUiDisplaySession) {
        _display.compareAndSet(session, null)
    }
}
