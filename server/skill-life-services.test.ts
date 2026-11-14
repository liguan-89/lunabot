import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundledSkills, selectBundledSkills } from "./skill-library.ts";

describe("life-services skill guide", () => {
  const skills = loadBundledSkills(join(process.cwd(), "skills"));
  const guide = skills.find((skill) => skill.manifest.id === "life-services")?.instructions ?? "";
  const ids = (text: string) => selectBundledSkills(text, [], skills).map((skill) => skill.manifest.id);

  it("mounts when a task needs a place, route or flight lookup, and stays out of unrelated talk", () => {
    for (const text of [
      "帮我查明天北京到上海的航班",
      "附近有什么好吃的餐厅",
      "这个地址怎么走，帮我规划路线",
      "check the flight status of CA1832",
      "find a cafe nearby and give me directions to it",
    ]) {
      expect(ids(text), text).toContain("life-services");
    }
    for (const text of ["写一个排序算法", "answer the question in chat", "summarize this document", "帮我整理笔记"]) {
      expect(ids(text), text).not.toContain("life-services");
    }
  });

  it("points at both official endpoints and keeps keys out of chat", () => {
    expect(guide).toContain("https://mcp.map.qq.com/sse");
    expect(guide).toContain("https://mcp.map.baidu.com/mcp");
    expect(guide).toContain("https://c-gw.variflight.com/chat_message/mcp/api/legacy");
    expect(guide).toContain("request_credential");
    expect(guide).toContain("Never ask for a key in chat");
  });
});
