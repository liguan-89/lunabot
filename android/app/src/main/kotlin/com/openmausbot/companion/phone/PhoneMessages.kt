package com.openmausbot.companion.phone

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.telephony.SmsManager
import androidx.core.content.ContextCompat
import com.openmausbot.companion.core.PhoneTool
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import androidx.core.net.toUri

/**
 * "Send a message" on Android. Two deliberately different paths:
 *
 * PHONE_SEND_MESSAGE and PHONE_SEND_WHATSAPP open a compose sheet — the text
 * leaves only when the person taps Send, and a bot can never put a message on
 * the wire by itself. PHONE_REPLY_SMS is the channels relay's answer to a
 * number that wrote in: it sends through SmsManager under the SEND_SMS grant
 * the messages switch asked for; the server pins `to` to the inbound sender.
 */
internal class PhoneMessages(private val context: Context) {
    fun execute(tool: PhoneTool, arguments: JsonObject): PhoneToolOutcome = when (tool) {
        PhoneTool.SEND_MESSAGE -> composeSms(arguments)
        PhoneTool.SEND_WHATSAPP -> composeWhatsApp(arguments)
        PhoneTool.REPLY_SMS -> replySms(arguments)
        else -> PhoneToolOutcome.Failure("这个工具不属于消息。", "unsupported")
    }

    /** The grants the messages switch asked for: reply sending and inbound relay. */
    fun canRelay(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED

    private fun replySms(arguments: JsonObject): PhoneToolOutcome {
        val to = arguments.string("to")
            ?: return PhoneToolOutcome.Failure("缺少收件人（to）。", "unsupported")
        val text = arguments.string("text")
            ?: return PhoneToolOutcome.Failure("缺少消息内容（text）。", "unsupported")
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            return PhoneToolOutcome.Failure("未授予短信权限，请在系统设置中允许。", "unsupported")
        }
        return try {
            val manager = smsManager()
                ?: return PhoneToolOutcome.Failure("这台设备没有短信功能。", "unsupported")
            send(manager, to, text)
            PhoneToolOutcome.Success(
                buildJsonObject {
                    put("sent", true)
                    put("channel", "sms")
                    put("to", to)
                },
            )
        } catch (error: Exception) {
            PhoneToolOutcome.Failure("短信发送失败：${error.message ?: "未知原因"}。", "unsupported")
        }
    }

    /**
     * ColorOS's SMS stack rejects the no-+ number form (RCS group lookup), while + fails local
     * forms — try both. `divideMessage` is also unreliable on some ROMs: it hits
     * `TelephonyManager.getGroupIdLevel1`, which throws SecurityException for normal apps.
     */
    private fun send(manager: SmsManager, to: String, text: String) {
        val parts = runCatching { manager.divideMessage(text).toList() }.getOrElse { splitParts(text) }
        try {
            if (parts.size <= 1) manager.sendTextMessage(to, null, text, null, null)
            else manager.sendMultipartTextMessage(to, null, ArrayList(parts), null, null)
        } catch (first: Exception) {
            if (to.startsWith("+") || !to.all(Char::isDigit)) throw first
            try {
                val international = "+$to"
                if (parts.size <= 1) manager.sendTextMessage(international, null, text, null, null)
                else manager.sendMultipartTextMessage(international, null, ArrayList(parts), null, null)
            } catch (_: Exception) {
                throw first
            }
        }
    }

    /** 160 chars single / 153 concat for GSM-7bit, 70 / 67 for UCS-2 (Chinese). */
    private fun splitParts(text: String): List<String> {
        val gsm7 = text.all { it.code < 0x80 }
        val single = if (gsm7) 160 else 70
        if (text.length <= single) return listOf(text)
        return text.chunked(if (gsm7) 153 else 67)
    }

    private fun smsManager(): SmsManager? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(SmsManager::class.java)
        } else {
            @Suppress("DEPRECATION")
            SmsManager.getDefault()
        }

    private fun composeSms(arguments: JsonObject): PhoneToolOutcome {
        val to = arguments.string("to")
            ?: return PhoneToolOutcome.Failure("缺少收件人（to）。", "unsupported")
        val text = arguments.string("text")
            ?: return PhoneToolOutcome.Failure("缺少消息内容（text）。", "unsupported")
        val intent = Intent(Intent.ACTION_SENDTO, "smsto:${Uri.encode(to)}".toUri())
            .putExtra("sms_body", text)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return launch(intent, channel = "sms", to = to)
    }

    private fun composeWhatsApp(arguments: JsonObject): PhoneToolOutcome {
        val to = arguments.string("to")
            ?: return PhoneToolOutcome.Failure("缺少收件人（to）。", "unsupported")
        val text = arguments.string("text")
            ?: return PhoneToolOutcome.Failure("缺少消息内容（text）。", "unsupported")
        // wa.me takes digits only; a leading + is allowed.
        val digits = to.filter { it.isDigit() || it == '+' }.removePrefix("+")
        if (digits.length < 6) {
            return PhoneToolOutcome.Failure("这个号码看起来不是手机号：$to。", "unsupported")
        }
        val intent = Intent(
            Intent.ACTION_VIEW,
            "https://wa.me/$digits?text=${Uri.encode(text)}".toUri(),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return launch(intent, channel = "whatsapp", to = to)
    }

    private fun launch(intent: Intent, channel: String, to: String): PhoneToolOutcome {
        return try {
            context.startActivity(intent)
            PhoneToolOutcome.Success(
                buildJsonObject {
                    put("opened", true)
                    put("channel", channel)
                    put("to", to)
                    // The computer's instructions tell the bot to say this is
                    // waiting for the person, not that it was sent.
                    put("awaiting", "send")
                },
            )
        } catch (_: ActivityNotFoundException) {
            PhoneToolOutcome.Failure("无法打开消息应用。", "unsupported")
        } catch (_: SecurityException) {
            // Android 10+ can refuse a background activity start. The person
            // opening the app is the honest remedy.
            PhoneToolOutcome.Failure(
                "手机不允许在后台打开消息应用，请先在手机上打开 Luna Bot 再试。",
                "unsupported",
            )
        }
    }
}

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)
