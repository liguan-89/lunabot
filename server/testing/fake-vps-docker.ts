import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  DRIVER_LABEL,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
} from "../container-computer.ts";
import { VPS_CONTAINER_LABEL, VPS_IMAGE, VPS_MANAGED_LABEL, VPS_VIEWER_LABEL } from "../vps-computer.ts";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const CONTAINER_ID = "b".repeat(64);
function imageInspectJson(): string {
  return JSON.stringify([
    {
      Id: IMAGE_ID,
      Config: {
        Labels: {
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
        },
      },
    },
  ]);
}

/** The fake docker substitutes __NAME__ from the inspect argv: the container name derives from a runtime bot id. */
function containerInspectTemplate(): string {
  return JSON.stringify([
    {
      Id: CONTAINER_ID,
      Name: "/__NAME__",
      Image: IMAGE_ID,
      Config: {
        Image: VPS_IMAGE,
        Labels: {
          [VPS_MANAGED_LABEL]: "1",
          [VPS_CONTAINER_LABEL]: "__NAME__",
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
          [VPS_VIEWER_LABEL]: "1",
        },
      },
      State: { Running: true },
      NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.5" } } },
      Mounts: [],
      HostConfig: {
        Binds: [],
        VolumesFrom: [],
        NetworkMode: "bridge",
        PortBindings: {},
        PublishAllPorts: false,
        Memory: 4 * 1024 * 1024 * 1024,
        MemorySwap: 4 * 1024 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        PidsLimit: 512,
        CapDrop: ["ALL"],
        CapAdd: ["CAP_SETUID", "CAP_SETGID"],
        Privileged: false,
        PidMode: "",
        IpcMode: "private",
        UTSMode: "",
        ShmSize: 512 * 1024 * 1024,
        Devices: [],
        DeviceRequests: [],
        SecurityOpt: [],
        UsernsMode: "",
        CgroupnsMode: "private",
        OomKillDisable: false,
        AutoRemove: false,
        RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      },
    },
  ]);
}

const fakeDocker = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
server=$(printf '%s' "$2" | sed 's|ssh://||')
if [ -f "$FAKE_DOCKER_DIR/unreachable.$server" ]; then echo "ssh: Could not resolve hostname $server: nodename nor servname provided, or not known" >&2; exit 255; fi
if [ -f "$FAKE_DOCKER_DIR/hold" ]; then
  : > "$FAKE_DOCKER_DIR/started"
  while [ -f "$FAKE_DOCKER_DIR/hold" ]; do sleep 0.05; done
fi
case "$*" in
  *" run "*) rm -f "$FAKE_DOCKER_DIR/container-missing" ;;
  *" start "*) sed 's/"Running":false/"Running":true/' "$FAKE_DOCKER_DIR/container.json.tpl" > "$FAKE_DOCKER_DIR/container.next"; mv "$FAKE_DOCKER_DIR/container.next" "$FAKE_DOCKER_DIR/container.json.tpl" ;;
  *" container ls "*)
    alias=$(printf '%s' "$2" | sed 's|ssh://||')
    if [ -f "$FAKE_DOCKER_DIR/inventory-empty" ]; then :;
    elif [ -f "$FAKE_DOCKER_DIR/container.name.$alias" ]; then echo "${CONTAINER_ID}";
    elif ls "$FAKE_DOCKER_DIR"/container.name.* >/dev/null 2>&1; then :;
    else echo "${CONTAINER_ID}"; fi ;;
  *" container inspect "*)
    alias=$(printf '%s' "$2" | sed 's|ssh://||')
    if [ -f "$FAKE_DOCKER_DIR/container.name.$alias" ]; then name=$(cat "$FAKE_DOCKER_DIR/container.name.$alias"); else name=$(cat "$FAKE_DOCKER_DIR/container.name"); fi
    sed "s|__NAME__|$name|g" "$FAKE_DOCKER_DIR/container.json.tpl" ;;
  *" image inspect "*)
    if [ -f "$FAKE_DOCKER_DIR/fail-inspect-once" ]; then
      rm "$FAKE_DOCKER_DIR/fail-inspect-once"
      echo "ssh: connection reset by peer" >&2
      exit 1
    fi
    cat "$FAKE_DOCKER_DIR/image.json" ;;
  *" exec "*"--version"*) echo "cua-driver ${CUA_DRIVER_VERSION}" ;;
  *" exec "*"--screenshot-out-file"*)
    : > "$FAKE_DOCKER_DIR/capture-started"
    while [ -f "$FAKE_DOCKER_DIR/hold-capture" ]; do sleep 0.05; done
    if [ -f "$FAKE_DOCKER_DIR/fail-capture" ]; then echo "fixture capture failed" >&2; exit 1; fi
    echo "{}" ;;
  *" exec "*"health_report"*) echo '{"schema_version":"1","overall":"ok","checks":[]}' ;;
  *" exec "*"scrot"*) echo "captured" ;;
  *" exec "*"get_desktop_state"*) echo "{}" ;;
  *" exec "*"base64"*) cat "$FAKE_DOCKER_DIR/screenshot.b64" ;;
  *" exec "*"status"*) echo "running" ;;
  *" exec "*"rm -f"*) : ;;
  *" rm -f "*) : ;;
  *" inspect "*)
    if [ -f "$FAKE_DOCKER_DIR/container-missing" ]; then echo "No such container" >&2; exit 1; fi
    for arg in "$@"; do name="$arg"; done
    alias=$(printf '%s' "$2" | sed 's|ssh://||')
    if [ -f "$FAKE_DOCKER_DIR/container.name.$alias" ]; then printf '%s' "$name" > "$FAKE_DOCKER_DIR/container.name.$alias"; else printf '%s' "$name" > "$FAKE_DOCKER_DIR/container.name"; fi
    sed "s|__NAME__|$name|g" "$FAKE_DOCKER_DIR/container.json.tpl" ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 64 ;;
esac
`;

export function writeFakeVpsDocker(directory: string): void {
  writeFileSync(join(directory, "docker"), fakeDocker, { mode: 0o755 });
  chmodSync(join(directory, "docker"), 0o755);
  // Only the viewer bridge's request/response is simulated; no SSH network or real VPS is contacted.
  writeFileSync(join(directory, "ssh"), `#!${process.execPath}
let request = '';
process.stdin.on('data', chunk => {
  request += chunk;
  if (request.includes('\\r\\n\\r\\n')) {
    process.stdout.write('HTTP/1.0 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok');
    request = '';
  }
});
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o755 });
  writeFileSync(join(directory, "image.json"), imageInspectJson());
  writeFileSync(join(directory, "container.json.tpl"), containerInspectTemplate());
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(600),
    Buffer.from("IEND", "ascii"),
  ]);
  writeFileSync(join(directory, "screenshot.b64"), png.toString("base64"));
}
