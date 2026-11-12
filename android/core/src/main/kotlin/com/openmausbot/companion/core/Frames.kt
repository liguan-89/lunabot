package com.openmausbot.companion.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

@Serializable
data class NotificationFrame(
    val kind: String,
    val botId: String,
    val botName: String,
    val threadId: String,
    val title: String,
    val body: String,
    /** The bot's stored profile image, when it has one. */
    val avatarUrl: String? = null,
    /** The room this came out of; absent when the bot spoke in its own thread. */
    val groupId: String? = null,
) {
    /**
     * Approval and question cards stop the bot until answered; a takeover is
     * the same demand on the person ("needs your hands"), so it belongs on the
     * blocking channel rather than next to "done".
     */
    val isBlocking: Boolean get() = kind == "approval" || kind == "question" || kind == "takeover"
}

@Serializable
data class RuntimeEvent(
    val type: String,
    val threadId: String,
    val delta: String? = null,
    val streamKind: String? = null,
)

@Serializable(with = FrameSerializer::class)
sealed interface Frame {
    data class Hello(val cursor: String, val resumed: Boolean) : Frame
    data class Message(val threadId: String, val message: com.openmausbot.companion.core.Message) : Frame
    data class MessagePatch(val threadId: String, val message: com.openmausbot.companion.core.Message) : Frame
    data class Thread(val threadId: String, val activeLeafId: String?) : Frame
    data class Bot(val bot: com.openmausbot.companion.core.Bot) : Frame
    data class BotDeleted(val botId: String) : Frame
    /** The desktop reordered the sidebar; ids not named here keep relative order. */
    data class BotsOrder(val botIds: List<String>) : Frame
    /** Something is waiting in this phone's job queue; the phone polls now. */
    data class DeviceJob(val phone: String, val id: String) : Frame
    data class BotQueued(val queues: Map<String, List<QueuedSend>>) : Frame
    data class Room(val room: com.openmausbot.companion.core.Room) : Frame
    data class RoomDeleted(val groupId: String) : Frame
    data class Notify(val notification: NotificationFrame) : Frame
    data class Routine(val routine: com.openmausbot.companion.core.Routine) : Frame
    data class RoutineRunFrame(val run: com.openmausbot.companion.core.RoutineRun) : Frame
    data class RoutineDeleted(val routineId: String) : Frame
    data class Screen(val botId: String, val png: String, val mime: String) : Frame
    data class Computer(val botId: String, val state: String) : Frame
    /** A Live call started, moved or ended on the desktop. The phone cannot
     *  join it, but a surface can say what is running and where. */
    data class LiveCall(
        val botId: String,
        val threadId: String,
        val call: com.openmausbot.companion.core.LiveCallRecord?,
    ) : Frame
    /** The computer lease changed, possibly from another device. */
    data class ComputerControl(val botId: String, val held: Boolean, val helpReason: String?) : Frame
    /** A tool server was changed on the desktop; the MCP card should reload. */
    data object McpChanged : Frame
    /** Desktop-only surfaces (webhooks, app triggers). Decoded so a newer
     *  computer's frame is named, not Unknown; this phone has nothing to fold. */
    data class DesktopOnly(val kind: String) : Frame
    data object Config : Frame
    /** The computer's routes changed mid-session (spec §3): the body is the
     * same snapshot `GET /api/companion/endpoints` returns. */
    data class CompanionEndpoints(val metadata: CompanionConnectionMetadata) : Frame
    data class Runtime(val event: RuntimeEvent) : Frame
    data class Unknown(val kind: String) : Frame

}

val Frame.threadId: String?
    get() = when (this) {
        is Frame.Message -> threadId
        is Frame.MessagePatch -> threadId
        is Frame.Thread -> threadId
        is Frame.Notify -> notification.threadId
        is Frame.Runtime -> event.threadId
        else -> null
    }

object FrameSerializer : KSerializer<Frame> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Frame")

    override fun deserialize(decoder: Decoder): Frame {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("Frame can only be decoded from JSON")
        val objectValue = input.decodeJsonElement().jsonObject
        val kind = objectValue.requiredString("kind")

        return when (kind) {
            "hello" -> Frame.Hello(
                cursor = objectValue.requiredString("cursor"),
                resumed = objectValue["resumed"]?.jsonPrimitive?.booleanOrNull ?: false,
            )
            "message" -> Frame.Message(
                threadId = objectValue.requiredString("threadId"),
                message = input.json.decodeFromJsonElement(
                    com.openmausbot.companion.core.Message.serializer(),
                    objectValue.required("message"),
                ),
            )
            "message.patch" -> Frame.MessagePatch(
                threadId = objectValue.requiredString("threadId"),
                message = input.json.decodeFromJsonElement(
                    com.openmausbot.companion.core.Message.serializer(),
                    objectValue.required("message"),
                ),
            )
            "thread" -> Frame.Thread(
                threadId = objectValue.requiredString("threadId"),
                activeLeafId = objectValue["activeLeafId"]?.jsonPrimitive?.contentOrNull,
            )
            "bot" -> Frame.Bot(input.json.decodeFromJsonElement(
                com.openmausbot.companion.core.Bot.serializer(),
                objectValue.required("bot"),
            ))
            "bot.deleted" -> Frame.BotDeleted(objectValue.requiredString("botId"))
            "bots.order" -> (objectValue["botIds"] as? JsonArray)
                ?.let { ids -> Frame.BotsOrder(ids.mapNotNull { it.jsonPrimitive.contentOrNull }) }
                ?: Frame.Unknown(kind)
            "device.job" -> Frame.DeviceJob(
                phone = objectValue["phone"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                id = objectValue["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            )
            "bot.queued" -> decodeBotQueued(objectValue) ?: Frame.Unknown(kind)
            "group" -> Frame.Room(input.json.decodeFromJsonElement(
                com.openmausbot.companion.core.Room.serializer(),
                objectValue.required("group"),
            ))
            "group.deleted" -> Frame.RoomDeleted(objectValue.requiredString("groupId"))
            "notify" -> Frame.Notify(input.json.decodeFromJsonElement(
                NotificationFrame.serializer(),
                objectValue.required("notification"),
            ))
            "routine" -> Frame.Routine(input.json.decodeFromJsonElement(
                com.openmausbot.companion.core.Routine.serializer(),
                objectValue.required("routine"),
            ))
            "routine.run" -> Frame.RoutineRunFrame(input.json.decodeFromJsonElement(
                com.openmausbot.companion.core.RoutineRun.serializer(),
                objectValue.required("run"),
            ))
            "routine.deleted" -> Frame.RoutineDeleted(objectValue.requiredString("routineId"))
            "screen" -> Frame.Screen(
                botId = objectValue.requiredString("botId"),
                png = objectValue.requiredString("png"),
                mime = objectValue["mime"]?.jsonPrimitive?.contentOrNull ?: "image/png",
            )
            "computer" -> Frame.Computer(
                botId = objectValue.requiredString("botId"),
                state = objectValue["state"]?.jsonPrimitive?.contentOrNull ?: "",
            )
            "live.call" -> Frame.LiveCall(
                botId = objectValue["botId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                threadId = objectValue["threadId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                call = objectValue["call"]?.let { element ->
                    runCatching {
                        input.json.decodeFromJsonElement(LiveCallRecord.serializer(), element)
                    }.getOrNull()
                },
            )
            "computer-control" -> Frame.ComputerControl(
                botId = objectValue["botId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                held = objectValue["held"]?.jsonPrimitive?.booleanOrNull ?: false,
                helpReason = objectValue["helpReason"]?.jsonPrimitive?.contentOrNull,
            )
            "mcp.changed" -> Frame.McpChanged
            // Desktop-only surfaces. The phone does not render webhooks or app
            // triggers, but naming them keeps a newer computer's frame out of
            // Unknown (and out of crash logs that would look like a bug).
            "webhook", "webhook.attempt", "webhook.deleted",
            "app-trigger", "app-trigger.attempt", "app-trigger.deleted", "app-trigger.service",
            -> Frame.DesktopOnly(kind)
            "config" -> Frame.Config
            "companion.endpoints" -> runCatching {
                Frame.CompanionEndpoints(
                    input.json.decodeFromJsonElement(CompanionConnectionMetadata.serializer(), objectValue),
                )
            }.getOrNull() ?: Frame.Unknown(kind)
            "runtime" -> Frame.Runtime(input.json.decodeFromJsonElement(
                RuntimeEvent.serializer(),
                objectValue.required("event"),
            ))
            else -> Frame.Unknown(kind)
        }
    }

    override fun serialize(encoder: Encoder, value: Frame) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("Frame can only be encoded as JSON")
        output.encodeJsonElement(value.toJsonObject(output))
    }
}

@Serializable(with = StreamFrameSerializer::class)
data class StreamFrame(val frame: Frame, val seq: Int? = null)

object StreamFrameSerializer : KSerializer<StreamFrame> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("StreamFrame")

    override fun deserialize(decoder: Decoder): StreamFrame {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("StreamFrame can only be decoded from JSON")
        val objectValue = input.decodeJsonElement().jsonObject
        return StreamFrame(
            frame = input.json.decodeFromJsonElement(FrameSerializer, objectValue),
            seq = objectValue["seq"]?.jsonPrimitive?.intOrNull,
        )
    }

    override fun serialize(encoder: Encoder, value: StreamFrame) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("StreamFrame can only be encoded as JSON")
        val frameObject = value.frame.toJsonObject(output)
        output.encodeJsonElement(buildJsonObject {
            frameObject.forEach { (key, element) -> put(key, element) }
            value.seq?.let { put("seq", it) }
        })
    }
}

private fun JsonObject.required(name: String) = this[name]
    ?: throw SerializationException("Frame is missing required field '$name'")

private fun JsonObject.requiredString(name: String): String =
    required(name).jsonPrimitive.contentOrNull
        ?: throw SerializationException("Frame field '$name' must be a string")

/**
 * A bot.queued frame is a wholesale snapshot of the server's steer queues.
 * A queues object this build cannot read is a broken frame, not the server
 * saying every queue is empty - reading it as one would retire every held
 * row on a glitch. Fall back to Unknown; the next frame or fleet snapshot
 * restates the truth. Bad entries inside a readable list still drop out
 * one by one.
 */
private fun decodeBotQueued(objectValue: JsonObject): Frame.BotQueued? = runCatching {
    Frame.BotQueued(
        queues = objectValue.required("queues").jsonObject.mapValues { (_, entries) ->
            entries.jsonArray.mapNotNull { element ->
                runCatching { element.jsonObject.queuedSendOrNull() }.getOrNull()
            }
        },
    )
}.getOrNull()

private fun Frame.toJsonObject(output: JsonEncoder): JsonObject = buildJsonObject {
    when (this@toJsonObject) {
        is Frame.Hello -> {
            put("kind", "hello")
            put("cursor", cursor)
            put("resumed", resumed)
        }
        is Frame.Message -> {
            put("kind", "message")
            put("threadId", threadId)
            put("message", output.json.encodeToJsonElement(com.openmausbot.companion.core.Message.serializer(), message))
        }
        is Frame.MessagePatch -> {
            put("kind", "message.patch")
            put("threadId", threadId)
            put("message", output.json.encodeToJsonElement(com.openmausbot.companion.core.Message.serializer(), message))
        }
        is Frame.Thread -> {
            put("kind", "thread")
            put("threadId", threadId)
            activeLeafId?.let { put("activeLeafId", it) }
        }
        is Frame.Bot -> {
            put("kind", "bot")
            put("bot", output.json.encodeToJsonElement(com.openmausbot.companion.core.Bot.serializer(), bot))
        }
        is Frame.BotDeleted -> {
            put("kind", "bot.deleted")
            put("botId", botId)
        }
        is Frame.BotsOrder -> {
            put("kind", "bots.order")
            put("botIds", JsonArray(botIds.map { JsonPrimitive(it) }))
        }
        is Frame.DeviceJob -> {
            put("kind", "device.job")
            put("phone", phone)
            put("id", id)
        }
        is Frame.BotQueued -> {
            put("kind", "bot.queued")
            put("queues", buildJsonObject {
                queues.forEach { (threadId, sends) ->
                    put(threadId, JsonArray(sends.map { it.toJsonObject() }))
                }
            })
        }
        is Frame.Room -> {
            put("kind", "group")
            put("group", output.json.encodeToJsonElement(com.openmausbot.companion.core.Room.serializer(), room))
        }
        is Frame.RoomDeleted -> {
            put("kind", "group.deleted")
            put("groupId", groupId)
        }
        is Frame.Notify -> {
            put("kind", "notify")
            put("notification", output.json.encodeToJsonElement(NotificationFrame.serializer(), notification))
        }
        is Frame.Routine -> {
            put("kind", "routine")
            put("routine", output.json.encodeToJsonElement(com.openmausbot.companion.core.Routine.serializer(), routine))
        }
        is Frame.RoutineRunFrame -> {
            put("kind", "routine.run")
            put("run", output.json.encodeToJsonElement(com.openmausbot.companion.core.RoutineRun.serializer(), run))
        }
        is Frame.RoutineDeleted -> {
            put("kind", "routine.deleted")
            put("routineId", routineId)
        }
        is Frame.Screen -> {
            put("kind", "screen")
            put("botId", botId)
            put("png", png)
            put("mime", mime)
        }
        is Frame.Computer -> {
            put("kind", "computer")
            put("botId", botId)
            put("state", state)
        }
        is Frame.LiveCall -> {
            put("kind", "live.call")
            put("botId", botId)
            put("threadId", threadId)
            call?.let { put("call", output.json.encodeToJsonElement(LiveCallRecord.serializer(), it)) }
        }
        is Frame.ComputerControl -> {
            put("kind", "computer-control")
            put("botId", botId)
            put("held", held)
            helpReason?.let { put("helpReason", it) }
        }
        Frame.McpChanged -> put("kind", "mcp.changed")
        is Frame.DesktopOnly -> put("kind", kind)
        Frame.Config -> put("kind", "config")
        is Frame.Runtime -> {
            put("kind", "runtime")
            put("event", output.json.encodeToJsonElement(RuntimeEvent.serializer(), event))
        }
        is Frame.CompanionEndpoints -> {
            put("kind", "companion.endpoints")
            for ((key, value) in output.json.encodeToJsonElement(CompanionConnectionMetadata.serializer(), metadata).jsonObject) {
                put(key, value)
            }
        }
        is Frame.Unknown -> put("kind", kind)
    }
}
