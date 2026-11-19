package com.openmausbot.companion.phone

import android.Manifest
import android.content.ContentProviderOperation
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import com.openmausbot.companion.core.ContactsAccess
import com.openmausbot.companion.core.PhoneTool
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * The contacts app, as bots see it: search by anything the phone's own contact
 * search matches, read one with numbers and emails, add one, or change one.
 *
 * Writes go through `ContactsContract`'s raw-contact batch so they land as one
 * aggregated contact; a phone is expected to sync it to whatever account the
 * person uses. Nothing leaves the device except the JSON the job result carries.
 */
internal class PhoneContacts(private val context: Context) {
    private val resolver get() = context.contentResolver

    fun access(): ContactsAccess {
        val read = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) ==
            PackageManager.PERMISSION_GRANTED
        val write = ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CONTACTS) ==
            PackageManager.PERMISSION_GRANTED
        return when {
            read && write -> ContactsAccess.READ_WRITE
            read -> ContactsAccess.READ
            else -> ContactsAccess.NONE
        }
    }

    fun execute(tool: PhoneTool, arguments: JsonObject): PhoneToolOutcome {
        val access = access()
        if (!access.canRead) {
            return PhoneToolOutcome.Failure("这台手机还没有允许读取联系人。", "denied")
        }
        if (tool.writes && !access.canWrite) {
            return PhoneToolOutcome.Failure("这台手机只允许读取联系人，不能修改。", "denied")
        }
        return runCatching {
            when (tool) {
                PhoneTool.SEARCH_CONTACTS -> search(arguments)
                PhoneTool.GET_CONTACT -> get(arguments)
                PhoneTool.CREATE_CONTACT -> create(arguments)
                PhoneTool.UPDATE_CONTACT -> update(arguments)
                else -> PhoneToolOutcome.Failure("这个工具不属于联系人。", "unsupported")
            }
        }.getOrElse { error ->
            PhoneToolOutcome.Failure(error.message?.takeIf { it.isNotBlank() } ?: "读取联系人失败。", "denied")
        }
    }

    private fun search(arguments: JsonObject): PhoneToolOutcome {
        val query = arguments.string("query") ?: return PhoneToolOutcome.Failure("缺少 query。", "unsupported")
        val uri = ContactsContract.Contacts.CONTENT_FILTER_URI.buildUpon()
            .appendPath(query)
            .build()
        val contacts = buildJsonArray {
            var count = 0
            resolver.query(
                uri,
                arrayOf(
                    ContactsContract.Contacts._ID,
                    ContactsContract.Contacts.DISPLAY_NAME,
                    ContactsContract.Contacts.HAS_PHONE_NUMBER,
                ),
                null,
                null,
                "${ContactsContract.Contacts.DISPLAY_NAME} ASC",
            )?.use { cursor ->
                while (cursor.moveToNext() && count < MAX_RESULTS) {
                    add(buildJsonObject {
                        put("id", cursor.getLong(0).toString())
                        put("name", cursor.getString(1).orEmpty())
                        put("hasPhone", cursor.getInt(2) > 0)
                    })
                    count++
                }
            }
        }
        return PhoneToolOutcome.Success(buildJsonObject { put("contacts", contacts) })
    }

    private fun get(arguments: JsonObject): PhoneToolOutcome {
        val id = arguments.string("id") ?: return PhoneToolOutcome.Failure("缺少 id。", "unsupported")
        val contact = queryContact(id) ?: return PhoneToolOutcome.Failure("没有找到这个联系人。", "not_found")
        return PhoneToolOutcome.Success(buildJsonObject { put("contact", contact) })
    }

    private fun create(arguments: JsonObject): PhoneToolOutcome {
        val given = arguments.string("givenName")
        val family = arguments.string("familyName")
        if (given == null && family == null) {
            return PhoneToolOutcome.Failure("至少需要名字或姓氏。", "unsupported")
        }
        val operations = mutableListOf<ContentProviderOperation>()
        operations += ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
            .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
            .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
            .build()
        val raw = 0
        if (given != null || family != null) {
            operations += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, raw)
                .withValue(
                    ContactsContract.Data.MIMETYPE,
                    ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE,
                )
                .apply {
                    given?.let {
                        withValue(ContactsContract.CommonDataKinds.StructuredName.GIVEN_NAME, it)
                    }
                    family?.let {
                        withValue(ContactsContract.CommonDataKinds.StructuredName.FAMILY_NAME, it)
                    }
                }
                .build()
        }
        for (phone in arguments.strings("phones")) {
            operations += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, raw)
                .withValue(
                    ContactsContract.Data.MIMETYPE,
                    ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE,
                )
                .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, phone)
                .withValue(
                    ContactsContract.CommonDataKinds.Phone.TYPE,
                    ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE,
                )
                .build()
        }
        for (email in arguments.strings("emails")) {
            operations += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, raw)
                .withValue(
                    ContactsContract.Data.MIMETYPE,
                    ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE,
                )
                .withValue(ContactsContract.CommonDataKinds.Email.ADDRESS, email)
                .withValue(
                    ContactsContract.CommonDataKinds.Email.TYPE,
                    ContactsContract.CommonDataKinds.Email.TYPE_OTHER,
                )
                .build()
        }
        arguments.string("organization")?.let { company ->
            operations += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, raw)
                .withValue(
                    ContactsContract.Data.MIMETYPE,
                    ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE,
                )
                .withValue(ContactsContract.CommonDataKinds.Organization.COMPANY, company)
                .build()
        }
        arguments.string("notes")?.let { note ->
            operations += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, raw)
                .withValue(
                    ContactsContract.Data.MIMETYPE,
                    ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE,
                )
                .withValue(ContactsContract.CommonDataKinds.Note.NOTE, note)
                .build()
        }

        val results = resolver.applyBatch(ContactsContract.AUTHORITY, ArrayList(operations))
        val rawId = ContentUris.parseId(results.first().uri ?: return notFound())
        val contactId = contactIdForRaw(rawId) ?: return notFound()
        val created = queryContact(contactId.toString()) ?: return notFound()
        return PhoneToolOutcome.Success(buildJsonObject { put("contact", created) })
    }

    private fun update(arguments: JsonObject): PhoneToolOutcome {
        val id = arguments.string("id") ?: return PhoneToolOutcome.Failure("缺少 id。", "unsupported")
        val rawId = rawContactFor(id) ?: return PhoneToolOutcome.Failure(
            "这个联系人没有可修改的本地记录。",
            "denied",
        )
        val operations = mutableListOf<ContentProviderOperation>()

        fun replaceMime(mime: String, fill: (ContentProviderOperation.Builder) -> Unit) {
            operations += ContentProviderOperation.newDelete(ContactsContract.Data.CONTENT_URI)
                .withSelection(
                    "${ContactsContract.Data.RAW_CONTACT_ID} = ? AND ${ContactsContract.Data.MIMETYPE} = ?",
                    arrayOf(rawId.toString(), mime),
                )
                .build()
            operations += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValue(ContactsContract.Data.RAW_CONTACT_ID, rawId)
                .withValue(ContactsContract.Data.MIMETYPE, mime)
                .apply(fill)
                .build()
        }

        val given = arguments.string("givenName")
        val family = arguments.string("familyName")
        if (given != null || family != null) {
            replaceMime(ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE) { builder ->
                given?.let {
                    builder.withValue(ContactsContract.CommonDataKinds.StructuredName.GIVEN_NAME, it)
                }
                family?.let {
                    builder.withValue(ContactsContract.CommonDataKinds.StructuredName.FAMILY_NAME, it)
                }
            }
        }
        arguments.string("organization")?.let { company ->
            replaceMime(ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE) { builder ->
                builder.withValue(ContactsContract.CommonDataKinds.Organization.COMPANY, company)
            }
        }
        arguments.string("notes")?.let { note ->
            replaceMime(ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE) { builder ->
                builder.withValue(ContactsContract.CommonDataKinds.Note.NOTE, note)
            }
        }
        // The lists replace what is there: an empty list is "remove them", which
        // is what a bot that read the contact and sent back the whole set means.
        if (arguments.has("phones")) {
            for (phone in arguments.strings("phones")) {
                operations += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValue(ContactsContract.Data.RAW_CONTACT_ID, rawId)
                    .withValue(
                        ContactsContract.Data.MIMETYPE,
                        ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE,
                    )
                    .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, phone)
                    .withValue(
                        ContactsContract.CommonDataKinds.Phone.TYPE,
                        ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE,
                    )
                    .build()
            }
        }
        if (arguments.has("emails")) {
            for (email in arguments.strings("emails")) {
                operations += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValue(ContactsContract.Data.RAW_CONTACT_ID, rawId)
                    .withValue(
                        ContactsContract.Data.MIMETYPE,
                        ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE,
                    )
                    .withValue(ContactsContract.CommonDataKinds.Email.ADDRESS, email)
                    .withValue(
                        ContactsContract.CommonDataKinds.Email.TYPE,
                        ContactsContract.CommonDataKinds.Email.TYPE_OTHER,
                    )
                    .build()
            }
        }
        if (operations.isEmpty()) {
            val unchanged = queryContact(id) ?: return notFound()
            return PhoneToolOutcome.Success(buildJsonObject { put("contact", unchanged) })
        }
        resolver.applyBatch(ContactsContract.AUTHORITY, ArrayList(operations))
        val updated = queryContact(id) ?: return notFound()
        return PhoneToolOutcome.Success(buildJsonObject { put("contact", updated) })
    }

    // MARK: - Reading

    private fun queryContact(id: String): JsonObject? {
        val contactUri = ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI, id.toLongOrNull() ?: return null)
        var displayName = ""
        var exists = false
        resolver.query(
            contactUri,
            arrayOf(ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME),
            null,
            null,
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                exists = true
                displayName = cursor.getString(1).orEmpty()
            }
        }
        if (!exists) return null

        val data = readData(id)
        return buildJsonObject {
            put("id", id)
            put("displayName", displayName)
            put("givenName", data.givenName ?: "")
            put("familyName", data.familyName ?: "")
            put("organization", data.organization ?: "")
            put("notes", data.notes ?: "")
            put("phones", buildJsonArray { data.phones.forEach { add(JsonPrimitive(it)) } })
            put("emails", buildJsonArray { data.emails.forEach { add(JsonPrimitive(it)) } })
        }
    }

    private data class ContactData(
        var givenName: String? = null,
        var familyName: String? = null,
        var organization: String? = null,
        var notes: String? = null,
        val phones: MutableList<String> = mutableListOf(),
        val emails: MutableList<String> = mutableListOf(),
    )

    private fun readData(contactId: String): ContactData {
        val data = ContactData()
        resolver.query(
            ContactsContract.Data.CONTENT_URI,
            arrayOf(
                ContactsContract.Data.MIMETYPE,
                ContactsContract.CommonDataKinds.StructuredName.GIVEN_NAME,
                ContactsContract.CommonDataKinds.StructuredName.FAMILY_NAME,
                ContactsContract.CommonDataKinds.Phone.NUMBER,
                ContactsContract.CommonDataKinds.Email.ADDRESS,
                ContactsContract.CommonDataKinds.Organization.COMPANY,
                ContactsContract.CommonDataKinds.Note.NOTE,
            ),
            "${ContactsContract.Data.CONTACT_ID} = ?",
            arrayOf(contactId),
            null,
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                when (cursor.getString(0)) {
                    ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE -> {
                        cursor.getStringOrNull(1)?.let { data.givenName = it }
                        cursor.getStringOrNull(2)?.let { data.familyName = it }
                    }
                    ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE ->
                        cursor.getStringOrNull(3)?.let { data.phones += it }
                    ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE ->
                        cursor.getStringOrNull(4)?.let { data.emails += it }
                    ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE ->
                        cursor.getStringOrNull(5)?.let { data.organization = it }
                    ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE ->
                        cursor.getStringOrNull(6)?.let { data.notes = it }
                }
            }
        }
        return data
    }

    private fun rawContactFor(contactId: String): Long? {
        resolver.query(
            ContactsContract.RawContacts.CONTENT_URI,
            arrayOf(ContactsContract.RawContacts._ID),
            "${ContactsContract.RawContacts.CONTACT_ID} = ?",
            arrayOf(contactId),
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) return cursor.getLong(0)
        }
        return null
    }

    private fun contactIdForRaw(rawId: Long): Long? {
        resolver.query(
            ContactsContract.RawContacts.CONTENT_URI,
            arrayOf(ContactsContract.RawContacts.CONTACT_ID),
            "${ContactsContract.RawContacts._ID} = ?",
            arrayOf(rawId.toString()),
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) return cursor.getLong(0)
        }
        return null
    }

    private fun android.database.Cursor.getStringOrNull(index: Int): String? =
        if (isNull(index)) null else getString(index)

    private fun notFound() = PhoneToolOutcome.Failure("没有找到这个联系人。", "not_found")

    private companion object {
        const val MAX_RESULTS = 20
    }
}

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }

private fun JsonObject.has(key: String): Boolean = this[key] != null && this[key] !is kotlinx.serialization.json.JsonNull

/** A list of strings, tolerating a single string (a bot that sent one number). */
private fun JsonObject.strings(key: String): List<String> {
    val element = this[key] ?: return emptyList()
    return when (element) {
        is JsonArray -> element.mapNotNull {
            (it as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)
        }
        is JsonPrimitive -> listOfNotNull(
            element.contentOrNull?.trim()?.takeIf(String::isNotEmpty),
        )
        else -> emptyList()
    }
}
