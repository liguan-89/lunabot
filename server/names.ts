import { byLanguage } from "./language.ts";

// 中国用户耳熟能详的角色名录，拉丁名（避开 x/q/zh/ü 难音），en 和简体 zh 共用。
const NAMES = [
  "Daji", "Angela", "Mulan", "Aobing", "Taiyi", "Yunying", "Luban", "Damo",
  "Wukong", "Nezha", "Bajie", "Yutu", "Pangu", "Nuwa", "Kirin", "Nian",
  "Vega", "Altair", "Kun", "Huluwa", "Shuke", "Beta", "Sanmao", "Maliang",
  "Afanti", "Paimon", "Klee", "Hutao", "Miko", "Ahri", "Jinx", "Teemo",
  "Yuumi", "Poro", "Mei", "Eggy", "Pikachu", "Eevee", "Snorlax", "Psyduck",
  "Gengar", "Mew", "Charmander", "Artemis", "Kero", "Jiji", "Doraemon",
  "Totoro", "Anya", "Gojo", "Nezuko", "Chopper", "Conan", "Maruko", "Shinchan",
  "Baymax", "Stitch", "Elsa", "Olaf", "Simba", "Minion", "Kuromi", "Labubu",
  "Peppa",
];

// 同一批角色的繁体名；游戏角色用台服译名（吉茵珂絲/普羅），小小兵为台湾官方译法。
const ZH_TW_NAMES = [
  "妲己", "安琪拉", "花木蘭", "敖丙", "太乙", "雲纓", "魯班", "達摩",
  "悟空", "哪吒", "八戒", "玉兔", "盤古", "女媧", "麒麟", "年獸",
  "織女", "牛郎", "鯤", "葫蘆娃", "舒克", "貝塔", "三毛", "馬良",
  "阿凡提", "派蒙", "可莉", "胡桃", "神子", "阿狸", "吉茵珂絲", "提莫",
  "悠米", "普羅", "小美", "蛋仔", "皮卡丘", "伊布", "卡比獸", "可達鴨",
  "耿鬼", "夢幻", "小火龍", "亞提密斯", "小可", "吉吉", "哆啦A夢", "龍貓",
  "安妮亞", "五條悟", "禰豆子", "喬巴", "柯南", "小丸子", "小新", "大白",
  "史迪奇", "艾莎", "雪寶", "辛巴", "小小兵", "酷洛米", "拉布布", "佩佩",
];

// "zh" falls back to en (the Latin roster); "zh-tw" needs its own entry for the Traditional names.
const POOLS = { en: NAMES, "zh-tw": ZH_TW_NAMES };

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

const PICKED = new Set([...NAMES, ...ZH_TW_NAMES].map((name) => name.toLowerCase()));

/** A name pickBotName could have given ("Pikachu", "Pikachu 2", "妲己", "妲己 2"): New bot sends one from /api/bot-defaults'
 * suggestedName. Every pool counts, so a name the server picked under another language still reads as picked. */
export function isPickedBotName(name: string): boolean {
  return PICKED.has(name.trim().toLowerCase().replace(/ \d+$/, ""));
}
