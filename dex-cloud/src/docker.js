import { request as httpRequest } from "node:http";

const DOCKER_TIMEOUT_MS = 60_000;

function dockerRequest(socket, method, path, body, timeoutMs = DOCKER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = httpRequest(
      {
        socketPath: socket,
        path,
        method,
        headers: {
          accept: "application/json",
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
          reject(Object.assign(new Error(`docker ${method} ${path} answered ${res.statusCode}`), { status: res.statusCode, body: parsed }));
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("docker request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function createDocker(socket) {
  const request = (method, path, body, timeoutMs) => dockerRequest(socket, method, path, body, timeoutMs);

  return {
    async imageExists(image) {
      try {
        await request("GET", `/images/${encodeURIComponent(image)}/json`);
        return true;
      } catch (error) {
        if (error.status === 404) return false;
        throw error;
      }
    },

    async ensureNetwork(name) {
      try {
        await request("POST", "/networks/create", { Name: name, Driver: "bridge", CheckDuplicate: true });
      } catch (error) {
        if (error.status !== 409) throw error;
      }
    },

    async createVolume(name) {
      try {
        return await request("POST", "/volumes/create", { Name: name });
      } catch (error) {
        if (error.status === 409) return null;
        throw error;
      }
    },

    async removeVolume(name) {
      try {
        await request("DELETE", `/volumes/${encodeURIComponent(name)}?force=1`);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    },

    async removeContainer(name) {
      try {
        await request("DELETE", `/containers/${encodeURIComponent(name)}?force=1&v=0`, undefined, 30_000);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    },

    async createContainer(name, spec) {
      return request("POST", `/containers/create?name=${encodeURIComponent(name)}`, spec);
    },

    async startContainer(name) {
      try {
        await request("POST", `/containers/${encodeURIComponent(name)}/start`, undefined, 30_000);
      } catch (error) {
        if (error.status !== 304) throw error;
      }
    },

    async stopContainer(name, timeoutSeconds = 15) {
      try {
        await request("POST", `/containers/${encodeURIComponent(name)}/stop?t=${timeoutSeconds}`, undefined, 30_000);
      } catch (error) {
        if (error.status !== 304 && error.status !== 404) throw error;
      }
    },

    async inspectContainer(name) {
      try {
        return await request("GET", `/containers/${encodeURIComponent(name)}/json`);
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },

    async createCloudContainer({ name, image, network, volume, env, memoryMb, nanoCpus }) {
      const spec = {
        Image: image,
        Env: env,
        Labels: { "lunabot.cloud": name },
        HostConfig: {
          Binds: [`${volume}:/data`],
          Init: true,
          ShmSize: 512 * 1024 * 1024,
          Memory: memoryMb * 1024 * 1024,
          MemorySwap: memoryMb * 2 * 1024 * 1024,
          RestartPolicy: { Name: "unless-stopped" },
          SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: 512,
          ...(nanoCpus ? { NanoCpus: nanoCpus } : {}),
        },
        NetworkingConfig: { EndpointsConfig: { [network]: {} } },
        Healthcheck: {
          Test: ["CMD", "curl", "-sf", "http://127.0.0.1:8080/api/health"],
          Interval: 15_000_000_000,
          Timeout: 5_000_000_000,
          StartPeriod: 60_000_000_000,
          Retries: 5,
        },
      };
      return request("POST", `/containers/create?name=${encodeURIComponent(name)}`, spec);
    },
  };
}
