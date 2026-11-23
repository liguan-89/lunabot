import { byLanguage } from "./language.ts";

const NAMES = [
  "Scout", "Pixel", "Atlas", "Nova", "Juno", "Koda", "Miso", "Mochi",
  "Biscuit", "Pepper", "Clover", "Ember", "Willow", "Comet", "Orbit", "Echo",
  "Indigo", "Sage", "Zephyr", "Poppy", "Maple", "Cosmo", "Luna", "Otto",
  "Ivy", "Finch", "Wren", "Basil", "Hazel", "Nimbus", "Onyx", "Pearl",
  "Quill", "Rocket", "Sunny", "Tango", "Vega", "Waffle", "Ziggy", "Noodle",
  "Pickle", "Churro", "Panko", "Dumpling", "Pesto", "Olive", "Cocoa", "Taffy",
  "Bramble", "Fig", "Juniper", "Moss", "Pebble", "Rio", "Skye", "Tuli",
  "Ursa", "Yuki", "Zuko", "Momo", "Kiwi", "Plum", "Sprout", "Turnip",
];

// 二十四节气 + 食物/叠词：中文用户熟悉的宠物式命名。
const ZH_NAMES = [
  "立春", "雨水", "惊蛰", "春分", "清明", "谷雨", "立夏", "小满",
  "芒种", "夏至", "小暑", "大暑", "立秋", "处暑", "白露", "秋分",
  "寒露", "霜降", "立冬", "小雪", "大雪", "冬至", "小寒", "大寒",
  "团子", "汤圆", "年糕", "米粒", "芝麻", "栗子", "花生", "瓜子",
  "可乐", "雪碧", "布丁", "奶茶", "糯米", "花卷", "馒头", "锅贴",
  "烧麦", "麻团", "青团", "粽子", "荔枝", "芒果", "椰果", "泡芙",
  "豆豆", "果果", "桃桃", "球球", "泡泡", "皮皮", "毛毛", "朵朵",
  "苗苗", "嘟嘟", "叮叮", "当当", "咚咚", "跳跳", "乐乐", "团团",
];

const ZH_TW_NAMES = [
  "立春", "雨水", "驚蟄", "春分", "清明", "穀雨", "立夏", "小滿",
  "芒種", "夏至", "小暑", "大暑", "立秋", "處暑", "白露", "秋分",
  "寒露", "霜降", "立冬", "小雪", "大雪", "冬至", "小寒", "大寒",
  "糰子", "湯圓", "年糕", "米粒", "芝麻", "栗子", "花生", "瓜子",
  "可樂", "雪碧", "布丁", "奶茶", "糯米", "花捲", "饅頭", "鍋貼",
  "燒賣", "麻糰", "青糰", "粽子", "荔枝", "芒果", "椰果", "泡芙",
  "豆豆", "果果", "桃桃", "球球", "泡泡", "皮皮", "毛毛", "朵朵",
  "苗苗", "嘟嘟", "叮叮", "噹噹", "咚咚", "跳跳", "樂樂", "團團",
];

// "zh-tw" needs its own entry: byLanguage would otherwise fall back to "zh" and hand Traditional users Simplified names.
const POOLS = { en: NAMES, zh: ZH_NAMES, "zh-tw": ZH_TW_NAMES };

export function pickBotName(taken: Iterable<string>, language?: string | (() => string)): string {
  const pool = byLanguage(POOLS, typeof language === "function" ? language() : language);
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const free = pool.filter((n) => !used.has(n.toLowerCase()));
  if (free.length > 0) return free[Math.floor(Math.random() * free.length)];
  const base = pool[Math.floor(Math.random() * pool.length)];
  for (let i = 2; ; i++) {
    if (!used.has(`${base.toLowerCase()} ${i}`)) return `${base} ${i}`;
  }
}

const PICKED = new Set([...NAMES, ...ZH_NAMES, ...ZH_TW_NAMES].map((name) => name.toLowerCase()));

/** A name pickBotName could have given ("Pesto", "Pesto 2", "团子", "团子 2"): New bot sends one from /api/bot-defaults'
 * suggestedName. Every pool counts, so a name the server picked under another language still reads as picked. */
export function isPickedBotName(name: string): boolean {
  return PICKED.has(name.trim().toLowerCase().replace(/ \d+$/, ""));
}
