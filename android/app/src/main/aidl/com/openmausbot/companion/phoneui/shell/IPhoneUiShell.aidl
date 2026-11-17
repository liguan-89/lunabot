/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * app/src/main/aidl/com/wangzan101/mika/shell/IMikaShell.aidl.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged and trimmed to the virtual-display, launcher-launch,
 * own-display input, task-move, key-text and keyguard-unlock endpoints. No
 * shell command, file, clipboard, audio, main-display input or system-intent
 * endpoints exist here. The keyguard endpoints (20-23) are the one place input
 * leaves the helper's own displays; they target a window uid, never a display,
 * and only while the keyguard is up.
 */

// Runs in the shell (uid 2000) helper process started via app_process; holds
// the agent's virtual displays. Every display-bound call must name a display
// this service itself created; the primary display is readable for spill
// detection and movable into, but never an input target.
package com.openmausbot.companion.phoneui.shell;

import android.view.Surface;

interface IPhoneUiShell {
    int createDisplay(in Surface surface, int width, int height, int dpi) = 1;
    void releaseDisplay(int displayId) = 2;
    // 0=launched 1=package is in use on the main display (not launched)
    // 2=no launcher entry 3=error
    int launchApp(int displayId, String packageName) = 3;
    boolean injectTap(int displayId, int x, int y) = 4;
    // One finger stroke: at times[i] ms (from touch-down) the finger is at
    // (xs[i], ys[i]); first point presses, last point lifts.
    boolean injectStroke(int displayId, in int[] xs, in int[] ys, in long[] times) = 5;
    boolean injectKey(int displayId, int keyCode) = 6;
    // Package of the top activity on this display; null when it has no task.
    String topPackage(int displayId) = 7;
    // [uid, pid] of the process serving this interface; the app side verifies
    // it matches the process that delivered the binder.
    int[] identity() = 8;
    // Task id of the most recent task on [displayId], or -1. Reading is
    // allowed for the main display too (spill detection); injecting is not.
    int topTaskId(int displayId) = 10;
    // Package of [taskId]'s top activity; null when the task is gone.
    String packageOfTask(int taskId) = 11;
    // Move root task [taskId] to [displayId]. Targets may be this helper's
    // display or the main display, never an arbitrary display.
    boolean moveTask(int taskId, int displayId) = 12;
    // Type printable ASCII into whichever field has focus on [displayId], by
    // synthesizing key events; refuses anything else.
    boolean typeText(int displayId, String text) = 13;
    // The primary clipboard's plain text, bounded by the helper; null when the
    // clip is not text or the system refuses the read.
    String readClipboard() = 14;
    // Replace the clipboard with plain text; refuses control characters and
    // oversized input.
    boolean writeClipboard(String text) = 15;
// Hand a content URI to [packageName]'s share screen on [displayId]. 0=opened
    // 2=no handler 3=error 5=start failed. The helper resolves the grant as
    // shell, which already holds storage access, so the target can read the
    // file without the app staying in the foreground.
    int shareIntent(int displayId, String contentUri, String mime, String packageName) = 16;
    // Finish [packageName] the way `am force-stop` does: its tasks and process
    // go away, as if the person swiped it out of recents. Called only when the
    // bot chose to close the app it drove; the caller refuses our own package,
    // the system UI and the helper, and a name that is not a package.
    boolean forceStop(String packageName) = 17;
    // Write one of two allow-listed settings as shell: "adb_wifi_enabled" or
    // "enabled_accessibility_services". A null value deletes the setting, which
    // is how the accessibility repair clears a list our service was the only
    // entry in. Shell holds WRITE_SECURE_SETTINGS, but the helper, not the
    // caller, owns the allow-list: any other name is refused and nothing is
    // written, so this endpoint cannot become a general settings writer.
    boolean putSecureSetting(String name, String value) = 18;
    // Grant [packageName] the one permission that lets it write the wireless
    // debugging switch after a reboot: WRITE_SECURE_SETTINGS. The helper, not
    // the caller, validates that the package belongs to the caller's uid; any
    // other name is refused and nothing is granted. Only this one permission
    // can be granted, so this is not a general permission granter. False when
    // the platform refuses the grant or `pm` is unavailable.
    boolean grantOwnWriteSecureSettings(String packageName) = 19;
    // Turn the screen on: a wake lock with ACQUIRE_CAUSES_WAKEUP plus
    // KEYCODE_WAKEUP, not injected anywhere. False when the screen did not
    // come on.
    boolean wakeDevice() = 20;
    // Swipe the keyguard from 85% to 45% of the screen height to reveal the
    // credential page. Each move is injected to the SystemUI *window uid*
    // (never to a display), and only while isKeyguardLocked && isDeviceLocked;
    // a swipe that starts while unlocked injects nothing.
    boolean revealKeyguard() = 21;
    // Type the device credential into the keyguard. [kind] is 0 (PIN) or 1
    // (password); [credential] is ASCII digits for a PIN and printable ASCII for
    // a password; [clear] is how many DEL presses to send first (the length of
    // a half-entered value, 0 for an empty field). Every key is injected to the
    // SystemUI window uid, re-checking the keyguard before each one, under an
    // 8 s deadline; the byte array is zeroized before returning. Refuses
    // anything else and injects nothing. Android 13+ only: earlier releases have
    // no targeted injectInputEvent overload and this returns false.
    boolean enterDeviceCredential(int kind, in byte[] credential, int clear) = 22;
    // One tap at (x, y) for the keyguard's "use PIN" style fallback button,
    // injected to the SystemUI window uid under the same keyguard checks. No
    // credential crosses this call.
    boolean tapKeyguard(int x, int y) = 23;
    // Release every display this binder's client created; called when the
    // client dies or detaches.
    void releaseAll() = 9;
    // releaseAll(), then end the helper process.
    void destroy() = 16777114;
}
