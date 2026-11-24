// 中国用户耳熟能详的角色名录，拉丁名（避开 x/q/zh/ü 难音）。
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

export function pickBotName(taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const free = NAMES.filter((n) => !used.has(n.toLowerCase()));
  if (free.length > 0) return free[Math.floor(Math.random() * free.length)];
  const base = NAMES[Math.floor(Math.random() * NAMES.length)];
  for (let i = 2; ; i++) {
    if (!used.has(`${base.toLowerCase()} ${i}`)) return `${base} ${i}`;
  }
}

const PICKED = new Set(NAMES.map((name) => name.toLowerCase()));

/** A name pickBotName could have given ("Pikachu", "Pikachu 2"): New bot sends one from /api/bot-defaults' suggestedName. */
export function isPickedBotName(name: string): boolean {
  return PICKED.has(name.trim().toLowerCase().replace(/ \d+$/, ""));
}
