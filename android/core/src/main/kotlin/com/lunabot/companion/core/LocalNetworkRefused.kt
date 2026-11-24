package com.lunabot.companion.core

/**
 * What the person reads when every way to their computer runs through this phone's own network and the platform is
 * refusing it — Android 17 until the local-network permission is granted.
 */
object LocalNetworkRefused {
    const val CONNECT = "未获得访问本地网络的权限，无法在同一 Wi-Fi 上连接这台电脑。"
    const val PAIR = "需要访问本地网络的权限，才能在同一 Wi-Fi 上与这台电脑配对。"

    /** Android lists the permission under Nearby devices, not under a name of its own. */
    const val SETTINGS = "请到系统设置 → 应用 → Luna Bot → 权限 → 附近设备 中开启。"
}
