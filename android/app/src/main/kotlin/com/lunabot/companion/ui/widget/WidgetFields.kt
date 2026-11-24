package com.lunabot.companion.ui.widget

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lunabot.companion.core.WIDGET_WEEKDAYS
import com.lunabot.companion.core.WidgetNode
import com.lunabot.companion.core.widgetDaysCaption
import com.lunabot.companion.core.widgetFieldOptions
import com.lunabot.companion.core.widgetString
import com.lunabot.companion.core.widgetTakesOther
import com.lunabot.companion.core.widgetTime
import com.lunabot.companion.core.widgetTimeSlots
import com.lunabot.companion.ui.minisDanger
import com.lunabot.companion.ui.minisInk
import com.lunabot.companion.ui.minisPaperBorder
import com.lunabot.companion.ui.minisSecondary
import com.lunabot.companion.ui.minisSeparator
import com.lunabot.companion.ui.minisSoftCard
import com.lunabot.companion.ui.minisTertiary
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** 一个表单控件：label 行 + 控件本体 + 必填红描边。Label 节点单独渲染（fieldName 对应）。 */
@Composable
fun WidgetFieldView(node: WidgetNode, form: WidgetFormState) {
    val name = node.str("name") ?: return
    val disabled = node.bool("disabled") || form.locked
    val invalid = form.problemField == name
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (name !in form.labelled) {
            widgetString(node, "label")?.let {
                Text(it, fontSize = 12.5.sp, fontWeight = FontWeight.Medium, color = if (invalid) minisDanger else minisSecondary)
            }
        }
        when (node.type) {
            "Select" -> SelectField(node, form, name, disabled, invalid)
            "RadioGroup" -> RadioField(node, form, name, disabled, invalid)
            "Checkbox" -> CheckboxField(node, form, name, disabled, invalid)
            "DatePicker" -> DateField(node, form, name, disabled, invalid)
            "TimePicker" -> TimeField(node, form, name, disabled, invalid)
            "DayPicker" -> DayField(node, form, name, disabled, invalid)
            "Input" -> InputField(node, form, name, disabled, invalid, multiline = false)
            "Textarea" -> InputField(node, form, name, disabled, invalid, multiline = true)
        }
        OtherInput(node, form, name, disabled)
    }
}

/** 「其他」自由填答：allowOther 的 Select/RadioGroup/命名 ListView 才有。 */
@Composable
private fun OtherInput(node: WidgetNode, form: WidgetFormState, name: String, disabled: Boolean) {
    if (!widgetTakesOther(node) || !form.other.containsKey(name)) return
    fieldTextBox(
        value = form.other[name] ?: "",
        onChange = { form.setOther(name, it) },
        placeholder = "输入你的答案",
        enabled = !disabled,
        invalid = false,
        singleLine = true,
    )
}

@Composable
private fun Modifier.fieldShell(invalid: Boolean, disabled: Boolean): Modifier = this
    .fillMaxWidth()
    .clip(RoundedCornerShape(12.dp))
    .border(
        1.dp,
        when {
            invalid -> minisDanger
            else -> minisPaperBorder
        },
        RoundedCornerShape(12.dp),
    )
    .background(if (disabled) minisSoftCard.copy(alpha = 0.5f) else minisSoftCard)

@Composable
private fun fieldTextBox(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    enabled: Boolean,
    invalid: Boolean,
    singleLine: Boolean,
    keyboard: KeyboardType = KeyboardType.Text,
    minHeight: Int = 40,
) {
    BasicTextField(
        value = value,
        onValueChange = onChange,
        enabled = enabled,
        singleLine = singleLine,
        textStyle = TextStyle(fontSize = 14.sp, color = minisInk),
        cursorBrush = SolidColor(minisInk),
        keyboardOptions = KeyboardOptions(keyboardType = keyboard),
        modifier = Modifier.fieldShell(invalid, !enabled).heightIn(min = minHeight.dp).padding(horizontal = 12.dp, vertical = 10.dp),
        decorationBox = { inner ->
            Box {
                if (value.isEmpty()) Text(placeholder, fontSize = 14.sp, color = minisTertiary)
                inner()
            }
        },
    )
}

private fun keyboardOf(inputType: String?): KeyboardType = when (inputType) {
    "number" -> KeyboardType.Number
    "email" -> KeyboardType.Email
    "tel" -> KeyboardType.Phone
    "url" -> KeyboardType.Uri
    else -> KeyboardType.Text
}

@Composable
private fun InputField(node: WidgetNode, form: WidgetFormState, name: String, disabled: Boolean, invalid: Boolean, multiline: Boolean) {
    fieldTextBox(
        value = form.value(name),
        onChange = { form.setValue(name, it) },
        placeholder = widgetString(node, "placeholder") ?: "",
        enabled = !disabled,
        invalid = invalid,
        singleLine = !multiline,
        keyboard = keyboardOf(node.str("inputType")),
        minHeight = if (multiline) ((node.num("rows") ?: 3.0).toInt() * 22 + 20) else 40,
    )
}

@Composable
private fun CheckboxField(node: WidgetNode, form: WidgetFormState, name: String, disabled: Boolean, invalid: Boolean) {
    val checked = form.checked(name)
    Row(
        Modifier.fillMaxWidth().clickable(enabled = !disabled) { form.setValue(name, !checked) }.padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier.size(20.dp).clip(RoundedCornerShape(6.dp))
                .border(if (invalid && !checked) 1.5.dp else 1.dp, if (invalid && !checked) minisDanger else minisSeparator, RoundedCornerShape(6.dp))
                .background(if (checked) minisInk else androidx.compose.ui.graphics.Color.Transparent),
            contentAlignment = Alignment.Center,
        ) {
            if (checked) Icon(Icons.Filled.Check, null, tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(13.dp))
        }
        widgetString(node, "label")?.let {
            Text(it, fontSize = 14.sp, color = if (invalid) minisDanger else minisInk)
        }
    }
}

@Composable
private fun RadioField(node: WidgetNode, form: WidgetFormState, name: String, disabled: Boolean, invalid: Boolean) {
    val options = widgetFieldOptions(node)
    val held = form.value(name)
    val takesOther = widgetTakesOther(node)
    val vertical = node.str("direction") != "row"
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        options.forEach { option ->
            val selected = held == option.value
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                    .clickable(enabled = !disabled) { form.setValue(name, option.value) }
                    .padding(horizontal = 4.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                RadioDot(selected, invalid)
                Text(option.label, fontSize = 14.sp, color = minisInk)
            }
        }
        if (takesOther) {
            val selected = form.other.containsKey(name)
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                    .clickable(enabled = !disabled) { form.chooseOther(name) }
                    .padding(horizontal = 4.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                RadioDot(selected, invalid)
                Text("其他", fontSize = 14.sp, color = if (selected) minisInk else minisSecondary)
            }
        }
    }
}

@Composable
private fun RadioDot(selected: Boolean, invalid: Boolean) {
    Box(
        Modifier.size(18.dp).border(1.5.dp, if (invalid) minisDanger else if (selected) minisInk else minisSeparator, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) Box(Modifier.size(9.dp).background(minisInk, CircleShape))
    }
}

@Composable
private fun SelectField(node: WidgetNode, form: WidgetFormState, name: String, disabled: Boolean, invalid: Boolean) {
    val options = widgetFieldOptions(node)
    val held = form.value(name)
    val takesOther = widgetTakesOther(node)
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.fieldShell(invalid, disabled).clickable(enabled = !disabled) { open = true }.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val shown = options.firstOrNull { it.value == held }?.label
                ?: if (form.other.containsKey(name)) form.other[name]?.ifBlank { "其他" } else null
            Text(
                shown ?: widgetString(node, "placeholder") ?: "选择",
                fontSize = 14.sp,
                color = if (shown != null) minisInk else minisTertiary,
                modifier = Modifier.weight(1f),
            )
            Icon(Icons.Filled.KeyboardArrowDown, null, tint = minisTertiary, modifier = Modifier.size(16.dp))
            if (node.bool("clearable") && (held.isNotEmpty() || form.other.containsKey(name))) {
                Icon(
                    Icons.Filled.Close, null, tint = minisTertiary,
                    modifier = Modifier.size(14.dp).clickable(enabled = !disabled) { form.setValue(name, "") },
                )
            }
        }
        androidx.compose.material3.DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { option ->
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text(option.label, fontSize = 14.sp) },
                    onClick = { form.setValue(name, option.value); open = false },
                )
            }
            if (takesOther) {
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text("其他…", fontSize = 14.sp) },
                    onClick = { form.chooseOther(name); open = false },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DateField(node: WidgetNode, form: WidgetFormState, name: String, disabled: Boolean, invalid: Boolean) {
    var open by remember { mutableStateOf(false) }
    val held = form.value(name)
    Row(
        Modifier.fieldShell(invalid, disabled).clickable(enabled = !disabled) { open = true }.padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            held.ifEmpty { widgetString(node, "placeholder") ?: "选择日期" },
            fontSize = 14.sp,
            color = if (held.isNotEmpty()) minisInk else minisTertiary,
            modifier = Modifier.weight(1f),
        )
        if (node.bool("clearable") && held.isNotEmpty()) {
            Icon(Icons.Filled.Close, null, tint = minisTertiary,
                modifier = Modifier.size(14.dp).clickable(enabled = !disabled) { form.setValue(name, "") })
        }
    }
    if (open) {
        val min = widgetString(node, "min")
        val max = widgetString(node, "max")
        val state = rememberDatePickerState(
            initialSelectedDateMillis = runCatching {
                SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(held.ifEmpty { min ?: "" })?.time
            }.getOrNull(),
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long): Boolean {
                    val day = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(utcTimeMillis))
                    return (min == null || day >= min) && (max == null || day <= max)
                }
            },
        )
        DatePickerDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { millis ->
                        form.setValue(name, SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(millis)))
                    }
                    open = false
                }) { Text("确定") }
            },
            dismissButton = { TextButton(onClick = { open = false }) { Text("取消") } },
        ) {
            DatePicker(state = state)
        }
    }
}

@Composable
private fun TimeField(node: WidgetNode, form: WidgetFormState, name: String, disabled: Boolean, invalid: Boolean) {
    var open by remember { mutableStateOf(false) }
    val held = widgetTime(form.value(name))
    Row(
        Modifier.fieldShell(invalid, disabled).clickable(enabled = !disabled) { open = true }.padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            held.ifEmpty { widgetString(node, "placeholder") ?: "选择时间" },
            fontSize = 14.sp,
            color = if (held.isNotEmpty()) minisInk else minisTertiary,
            modifier = Modifier.weight(1f),
        )
        if (node.bool("clearable") && held.isNotEmpty()) {
            Icon(Icons.Filled.Close, null, tint = minisTertiary,
                modifier = Modifier.size(14.dp).clickable(enabled = !disabled) { form.setValue(name, "") })
        }
    }
    if (open) {
        val slots = remember(node, held) { widgetTimeSlots(node, held) }
        AlertDialog(
            onDismissRequest = { open = false },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { open = false }) { Text("取消") } },
            title = { Text(widgetString(node, "label") ?: "选择时间", fontSize = 15.sp, fontWeight = FontWeight.SemiBold) },
            text = {
                LazyColumn(Modifier.heightIn(max = 280.dp)) {
                    items(slots) { slot ->
                        val chosen = slot == held
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                                .clickable { form.setValue(name, slot); open = false }
                                .background(if (chosen) minisSoftCard else androidx.compose.ui.graphics.Color.Transparent)
                                .padding(horizontal = 12.dp, vertical = 9.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(slot, fontSize = 14.sp, color = minisInk, modifier = Modifier.weight(1f))
                            if (chosen) Icon(Icons.Filled.Check, null, tint = minisInk, modifier = Modifier.size(14.dp))
                        }
                    }
                }
            },
        )
    }
}

@Composable
private fun DayField(node: WidgetNode, form: WidgetFormState, name: String, disabled: Boolean, invalid: Boolean) {
    val held = form.value(name)
    val picked = held.split(",").filter { it in WIDGET_WEEKDAYS }.toSet()
    val names = listOf("一", "二", "三", "四", "五", "六", "日")
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            WIDGET_WEEKDAYS.forEachIndexed { index, day ->
                val on = day in picked
                Box(
                    Modifier.size(32.dp).clip(CircleShape)
                        .background(if (on) minisInk else minisInk.copy(alpha = 0.07f))
                        .then(if (!on && invalid) Modifier.border(1.5.dp, minisDanger, CircleShape) else Modifier)
                        .clickable(enabled = !disabled) {
                            val next = WIDGET_WEEKDAYS.filter { each -> if (each == day) !on else each in picked }
                            form.setValue(name, next.joinToString(","))
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(names[index], fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = if (on) androidx.compose.ui.graphics.Color.White else minisSecondary)
                }
            }
        }
        Text(widgetDaysCaption(held), fontSize = 12.sp, color = if (picked.isEmpty() && invalid) minisDanger else minisTertiary)
    }
}
