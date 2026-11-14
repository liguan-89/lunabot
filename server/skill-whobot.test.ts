import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundledSkills, selectBundledSkills } from "./skill-library.ts";

describe("whobot-phonecall skill guide", () => {
  const skills = loadBundledSkills(join(process.cwd(), "skills"));
  const guide = skills.find((skill) => skill.manifest.id === "whobot-phonecall")?.instructions ?? "";
  const ids = (text: string) => selectBundledSkills(text, [], skills).map((skill) => skill.manifest.id);

  it("mounts when a bot is asked to place a phone call, and stays out of unrelated talk", () => {
    for (const text of ["帮我给楼下餐厅打电话订今晚两个人的位子", "安排一次外呼回访这批客户", "用呼波特给张先生打个电话", "call the restaurant and book a table for two", "place an outbound call to this lead", "use whobot to phone the dentist"]) {
      expect(ids(text), text).toContain("whobot-phonecall");
    }
    for (const text of ["the callback function is async", "answer the question in chat", "call the method twice", "帮我整理今天的通话记录摘要，不用拨号"]) {
      expect(ids(text), text).not.toContain("whobot-phonecall");
    }
  });

  it("keeps the CLI protocol as the source of truth", () => {
    expect(guide).toContain("whobot status --skill 2.1.1");
    expect(guide).toContain("whobot call result");
  });
});
