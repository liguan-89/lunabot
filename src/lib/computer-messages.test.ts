import { afterEach, expect, it } from "vitest";

import { localizeComputerProblem } from "./computer-messages";
import { setLocale } from "./i18n";

afterEach(() => setLocale("en"));

it("words the container runtime problems the server reports, and keeps any other text", () => {
  expect(localizeComputerProblem("Install a supported container runtime first")).toBe("Install a supported container runtime first");
  expect(localizeComputerProblem("Start docker first")).toBe("Start docker first");
  setLocale("zh");
  expect(localizeComputerProblem("Install a supported container runtime first")).toBe("请先安装受支持的容器运行时");
  expect(localizeComputerProblem("Start podman first")).toBe("请先启动 podman");
  expect(localizeComputerProblem("Something new")).toBe("Something new");
});
