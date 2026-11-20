package com.lunabot.companion.phoneui

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.MediaStore

/**
 * Which packages are the system's own pickers (permission dialog, chooser,
 * file and photo pickers) and which are the person's home / system UI.
 *
 * Adapted from Mika's SystemPickers (app/src/main/java/com/wangzan101/mika/cap/phone/a11y/
 * SystemPickers.kt), Copyright 2026 wangzan101, Apache License 2.0
 * (third_party/mika/LICENSE). Changes: home and system UI are resolved here
 * too, since this app uses one set for spill decisions.
 *
 * Resolved from standard intents rather than hard-coded package names, so OEM
 * pickers (MIUI included) are recognised when they answer the same intents.
 */
internal object PhoneUiSystemPickers {
    const val ANDROID = "android"
    private const val ACTION_REQUEST_PERMISSIONS = "android.content.pm.action.REQUEST_PERMISSIONS"

    /** The system UI process is not an app page: it owns recents and the shade. */
    private const val SYSTEM_UI = "com.android.systemui"

    private fun pickerIntents(): List<Intent> = buildList {
        add(Intent(ACTION_REQUEST_PERMISSIONS))
        add(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain"), null))
        add(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Intent(MediaStore.ACTION_PICK_IMAGES))
        }
    }

    /** Packages that ask the person a question instead of being the app's own page. */
    fun resolve(pm: PackageManager): Set<String> =
        pickerIntents().mapNotNull { intent ->
            runCatching { pm.resolveActivity(intent, 0)?.activityInfo?.packageName }.getOrNull()
        }.toSet() + ANDROID

    /** The home screen; an app the person opened from it is not a spill of ours. */
    fun homePackages(pm: PackageManager): Set<String> {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val resolved = runCatching { pm.resolveActivity(home, 0)?.activityInfo?.packageName }.getOrNull()
        return (listOfNotNull(resolved, SYSTEM_UI)).toSet()
    }
}