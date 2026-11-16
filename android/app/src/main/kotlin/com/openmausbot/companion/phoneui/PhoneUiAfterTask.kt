package com.openmausbot.companion.phoneui

/**
 * What happens to the app a task drove once the task ends. The bot chooses
 * through PHONE_UI_AFTER_TASK; the executor records the choice here and acts
 * on it in [PhoneUiTaskExecutor.release].
 *
 * Kept apart from the executor so the decision is testable without a device:
 * keeping the app is the default and finishes nothing, and closing one is
 * refused for the packages this app must never finish (its own, the system UI
 * and the shell helper it runs on).
 */
internal class PhoneUiAfterTask {
    /** The bot's choice, or null when it never made one: keeping is the default. */
    @Volatile
    var choice: Choice? = null
        private set

    /** The package the choice names; null means the app the task drove last. */
    @Volatile
    var packageName: String? = null
        private set

    /**
     * Remember [choice] for the rest of the task, with the package it names;
     * the executor validates the package before it gets here.
     */
    @Synchronized
    fun record(choice: Choice, packageName: String? = null) {
        this.choice = choice
        this.packageName = packageName
    }

    /** Forget the choice: the next task starts from the default again. */
    @Synchronized
    fun clear() {
        choice = null
        packageName = null
    }

    /** What release does now, with the app the task drove last as the fallback target. */
    fun decide(lastPackage: String?, selfPackage: String, systemUi: Set<String> = SYSTEM_UI_PACKAGES): Decision =
        whatToDo(choice, packageName ?: lastPackage, selfPackage, systemUi)

    /** The choice, by the word that travels on the wire. */
    enum class Choice(val wire: String) {
        /** Leave the app running in the background; only the display goes away. */
        KEEP("keep"),

        /** Finish the app. */
        CLOSE("close"),
        ;

        companion object {
            /** The choice [value] names, or null when it names none. */
            fun parse(value: String?): Choice? = entries.firstOrNull { it.wire == value?.trim()?.lowercase() }
        }
    }

    /** What release does with the app. */
    sealed class Decision {
        /** Leave the app alone; the display is released as before. */
        data object Keep : Decision()

        /** Finish [packageName]. */
        data class Close(val packageName: String) : Decision()

        /** Nothing to act on: no package was recorded, or it may not be finished. */
        data object Nothing : Decision()
    }

    companion object {
        /**
         * Packages this app never finishes: the framework and system UI own the
         * phone's own screens, and com.android.shell is the helper's process.
         */
        val SYSTEM_UI_PACKAGES: Set<String> = setOf("android", "com.android.systemui", "com.android.shell")

        /**
         * The decision for [choice]. Keeping is the default, and with no choice
         * recorded it is also today's behaviour: release closes the display and
         * nothing else. Closing needs a package that passes
         * [PhoneUiRules.isValidPackageName] and is neither [selfPackage] nor one
         * of [systemUi].
         */
        fun whatToDo(choice: Choice?, lastPackage: String?, selfPackage: String, systemUi: Set<String>): Decision {
            if (choice != Choice.CLOSE) return Decision.Keep
            val pkg = lastPackage ?: return Decision.Nothing
            if (!PhoneUiRules.isValidPackageName(pkg)) return Decision.Nothing
            if (pkg == selfPackage || pkg in systemUi) return Decision.Nothing
            return Decision.Close(pkg)
        }
    }
}
