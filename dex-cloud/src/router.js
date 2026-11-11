import { connect, createServer } from "node:net";

const MAX_HEADER_BYTES = 16 * 1024;

/** Routes a plain HTTP/1.1 connection by its Host header to that Cloud's container on the shared Docker network. */
export function createRouter({ config, store, log = console.log }) {
  return createServer((socket) => {
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let routed = false;

    const refuse = (status, reason) => {
      if (routed) return;
      routed = true;
      socket.end(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    };

    const onData = (chunk) => {
      if (routed) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_HEADER_BYTES) return refuse(431, "Request Header Fields Too Large");
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      socket.pause();
      const head = buffer.subarray(0, end).toString("latin1");
      const hostMatch = /^Host:[ \t]*([^\r\n]+)/im.exec(head);
      const host = hostMatch ? hostMatch[1].trim().split(":")[0].toLowerCase() : "";
      if (!host.endsWith(`.${config.cloudHostSuffix}`)) return refuse(421, "Misdirected Request");
      const cloud = store.cloudByHostname(host);
      if (!cloud || !["setting_up", "ready", "offline"].includes(cloud.status)) return refuse(404, "Not Found");
      routed = true;
      const upstream = connect(8080, `dexcloud-${cloud.id}`);
      upstream.on("connect", () => {
        upstream.write(buffer);
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.resume();
      });
      upstream.on("error", (error) => {
        log(`router ${host} upstream failed: ${error?.message ?? error}`);
        socket.destroy();
      });
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    };

    socket.on("data", onData);
  });
}
