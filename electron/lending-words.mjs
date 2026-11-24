// The activity log's words in each language the app speaks, for main's own window of it. The packaged app ships the
// renderer's catalog only inside its page bundle, so main keeps these keys itself; a test holds them equal to src/locales.

export const WORDS = Object.freeze({
  "en": Object.freeze({
    "lending.activity.title": "Activity on this computer",
    "lending.activity.empty": "Nothing yet. Every request from its bots will be listed here, including refused ones.",
    "lending.activity.refused": "refused",
    "lending.action.listFiles": "Listed a folder",
    "lending.action.readFile": "Read a file",
    "lending.action.writeFile": "Saved a file",
    "lending.action.deleteFile": "Deleted a file",
    "lending.action.runCommand": "Ran a command",
    "lending.action.screenTools": "Checked the app and screen controls",
    "lending.action.screen": "Used apps and screen",
    "lending.action.website": "Opened a website",
    "lending.action.chrome": "Used your Chrome",
    "lending.action.invalid": "Malformed request",
    "lending.action.other": "Other request",
  }),
  "zh": Object.freeze({
    "lending.activity.title": "这台电脑上的活动",
    "lending.activity.empty": "暂无活动。那里的机器人发出的每个请求都会列在这里，包括被拒绝的请求。",
    "lending.activity.refused": "已拒绝",
    "lending.action.listFiles": "列出了一个文件夹",
    "lending.action.readFile": "读取了一个文件",
    "lending.action.writeFile": "保存了一个文件",
    "lending.action.deleteFile": "删除了一个文件",
    "lending.action.runCommand": "运行了一条命令",
    "lending.action.screenTools": "检查了应用和屏幕控制",
    "lending.action.screen": "使用了应用和屏幕",
    "lending.action.website": "打开了一个网站",
    "lending.action.chrome": "使用了你的 Chrome",
    "lending.action.invalid": "格式错误的请求",
    "lending.action.other": "其他请求",
  }),
});

/** The words for `locale` (a language tag such as "zh-CN"), found the way the page finds its language; English for any
 * other. */
export function wordsFor(locale) {
  for (let candidate = typeof locale === "string" ? locale.toLowerCase() : ""; candidate;) {
    if (Object.hasOwn(WORDS, candidate)) return { ...WORDS.en, ...WORDS[candidate] };
    const cut = candidate.lastIndexOf("-");
    if (cut < 0) break;
    candidate = candidate.slice(0, cut);
  }
  return WORDS.en;
}
