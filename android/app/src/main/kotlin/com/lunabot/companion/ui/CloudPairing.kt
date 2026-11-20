package com.lunabot.companion.ui

import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf

/**
 * A Cloud desktop pairing whose code was minted for this account in Settings,
 * waiting for [PairingScreen] to redeem it.
 *
 * This is a hand-off, not a second pairing path. Settings offers the request and
 * asks `Session` to open the pairing screen; the screen takes the request once,
 * opens the ordinary pending attempt with the code already filled in, and
 * submits it through the same transaction a typed code uses. That transaction is
 * what writes the connection and its device token to disk — a direct `pair`
 * call from Settings skipped the screen's attempt bookkeeping and left nothing
 * restorable behind.
 *
 * The code is a one-time secret, so it lives in process memory and nowhere else
 * (§6). A process restart drops it, and the request with it: replaying a code
 * that may already have reached the Cloud is the one thing that must not happen.
 */
internal data class CloudPairingRequest(
    val origin: String,
    val code: String,
    /** The Cloud's name, for the failure message if the address will not parse. */
    val name: String,
)

internal object CloudPairingInbox {
    private val _pending = mutableStateOf<CloudPairingRequest?>(null)

    /** Readable from composition, but only [consume] clears it. */
    val pending: State<CloudPairingRequest?> = _pending

    fun offer(request: CloudPairingRequest) {
        _pending.value = request
    }

    /**
     * Take the request, leaving the inbox empty.
     *
     * One consumer by construction: the screen that wins the read is the only
     * one that gets the code, so a recomposition or a second visit to the
     * pairing form cannot redeem the same one-time code twice.
     */
    fun consume(): CloudPairingRequest? {
        val request = _pending.value ?: return null
        _pending.value = null
        return request
    }
}

/**
 * A computer's approval, carrying the same `lunabot://pair` link a scanned QR
 * does. Settings offers it and asks `Session` to open the pairing screen, which
 * feeds it through `receivePairingURL` — the path a scan already takes, so the
 * confirmation, the attempt transaction and the saved connection are unchanged.
 *
 * The link is a one-time credential, so it lives in process memory only.
 */
internal data class ComputerPairingRequest(
    val link: String,
    /** The computer's name, for a failure line that names what failed. */
    val name: String,
)

internal object ComputerPairingInbox {
    private val _pending = mutableStateOf<ComputerPairingRequest?>(null)

    val pending: State<ComputerPairingRequest?> = _pending

    fun offer(request: ComputerPairingRequest) {
        _pending.value = request
    }

    fun consume(): ComputerPairingRequest? {
        val request = _pending.value ?: return null
        _pending.value = null
        return request
    }
}
