/*
 * Ported from Mika (https://github.com/wangzan101/Mika), file
 * app/src/main/aidl/com/wangzan101/mika/shell/IMikaShell.aidl.
 * Copyright 2026 wangzan101. The original is licensed under the Apache License,
 * Version 2.0 (third_party/mika/LICENSE in this repository).
 *
 * Modifications Copyright 2026 OpenMausBot contributors. Changes from the
 * original: repackaged and trimmed to the virtual-display, launcher-launch,
 * own-display input, task-move and key-text endpoints. No shell command, file,
 * clipboard, audio, device-unlock, main-display input or system-intent
 * endpoints exist here.
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
    // Release every display this binder's client created; called when the
    // client dies or detaches.
    void releaseAll() = 9;
    // releaseAll(), then end the helper process.
    void destroy() = 16777114;
}
