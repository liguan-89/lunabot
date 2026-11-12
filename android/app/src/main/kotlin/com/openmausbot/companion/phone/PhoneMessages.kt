package com.openmausbot.companion.phone

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.openmausbot.companion.core.PhoneTool
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import androidx.core.net.toUri

/**
 * "Send a message" on Android, which is deliberately *not* sending it.
 *
 * The computer's own tool description says the same: PHONE_SEND_MESSAGE and
 * PHONE_SEND_WHATSAPP open a compose sheet, and the message leaves only when
 * the person taps Send. So this class starts the system SMS composer or
 * WhatsApp with the text filled in and reports back that the phone is waiting
 * for the person. It never asks for SEND_SMS, and a bot cannot put a text on
 * the wire by itself.
 */
internal class PhoneMessages(private val context: Context) {
    fun execute(tool: PhoneTool, arguments: JsonObject): PhoneToolOutcome = when (tool) {
        PhoneTool.SEND_MESSAGE -> composeSms(arguments)
        PhoneTool.SEND_WHATSAPP -> composeWhatsApp(arguments)
        else -> PhoneToolOutcome.Failure("这个工具不属于消息。", "unsupported")
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
                "手机不允许在后台打开消息应用，请先在手机上打开 DEX BOT 再试。",
                "unsupported",
            )
        }
    }
}

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)
