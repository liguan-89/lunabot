// An adhoc-signed macOS app cannot be replaced by Squirrel.Mac (see app-signing.mjs), so its updates arrive as the
// release's own .dmg: this downloads that disk image, checks it against the feed's sha512, stages the bundle out of
// it, and a detached swap puts it in place once the app quits. The person only drags the image in when staging fails.
// electron-updater still does the checking — it just never downloads or stages.
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { UPDATE_TEXT, updateErrorCode } from "./update-errors.mjs";
import { releaseNotesText } from "./updater-coordinator.mjs";
import { updateWords } from "./update-words.mjs";

/** The `url:` line electron-builder writes into Resources/app-update.yml. electron-updater's getFeedURL() is a stub. */
export function feedBaseUrl({ resourcesPath = process.resourcesPath, readFile = readFileSync } = {}) {
  if (typeof resourcesPath !== "string" || resourcesPath.length === 0) return null;
  let text;
  try {
    text = String(readFile(join(resourcesPath, "app-update.yml"), "utf8"));
  } catch {
    return null;
  }
  const match = /^url:\s*(\S+)\s*$/m.exec(text);
  return match ? match[1] : null;
}

/** The feed entry the person installs from, with its URL resolved against the feed. */
export function imageFromFeed(info, baseUrl) {
  const files = Array.isArray(info?.files) ? info.files : [];
  const entry = files.find((file) => typeof file?.url === "string" && /\.dmg(?:$|[?#])/i.test(file.url));
  if (!entry) return null;
  let url;
  try {
    // electron-builder's feed URL names a directory; without the trailing slash URL() would drop its last segment.
    const base = typeof baseUrl === "string" && baseUrl.length > 0
      ? (baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`)
      : undefined;
    url = new URL(entry.url, base).toString();
  } catch {
    return null;
  }
  return {
    url,
    name: basename(new URL(url).pathname),
    sha512: typeof entry.sha512 === "string" && entry.sha512.trim() ? entry.sha512.trim() : null,
    size: Number.isFinite(entry.size) && entry.size > 0 ? entry.size : null,
  };
}

/** The digest of a whole file, as electron-builder records it in the feed: base64 of SHA-512. */
export function sha512OfFile(file) {
  return createHash("sha512").update(readFileSync(file)).digest("base64");
}

function checksumError() {
  return Object.assign(new Error("sha512 mismatch"), { code: "ERR_UPDATER_CHECKSUM_MISMATCH" });
}

/** An error whose words travel with it: `message` for this process, `messageKey` for the window's own language. */
function wordedError(key) {
  const words = updateWords(key);
  return Object.assign(new Error(words.message), words);
}

/**
 * The same shape the updater coordinator exposes — check(), install(), installable() — over a downloaded disk image
 * instead of a native stage. `swap` stages the bundle out of the image and arms the detached install, `quit` leaves
 * the app so it can run; the person only drags the image in when `swap` is missing or staging fails. Every failure is
 * retryable: nothing here can leave a half-installed app behind.
 */
export function createImageUpdateCoordinator(updater, setState, {
  baseUrl = null,
  downloadDir,
  openPath,
  swap = null,
  quit = null,
  fetchImpl = (...args) => fetch(...args),
  hashFile = sha512OfFile,
  log = () => {},
} = {}) {
  let checkOperation = null;
  let downloadOperation = null;
  let installOperation = null;
  // { version, file } — a downloaded image the person has not opened yet.
  let staged = null;
  let actionOwnsState = false;
  const routedErrors = new WeakSet();

  const said = (error) => {
    if (error?.messageKey) {
      return { message: error.message, messageKey: error.messageKey, ...(error.messageParams ? { messageParams: error.messageParams } : {}) };
    }
    // The same classification the native updater's failures get, so a dropped connection reads as one here too.
    const code = updateErrorCode(error);
    return code ? { message: UPDATE_TEXT[code], messageCode: code } : { message: error?.message ?? String(error) };
  };

  const fail = (error) => {
    if (error instanceof Error) routedErrors.add(error);
    staged = null;
    if (downloadOperation) {
      downloadOperation.failed = true;
      downloadOperation = null;
    }
    if (checkOperation) checkOperation.failed = true;
    installOperation = null;
    // An image hand-off has no half-installed state, so every failure stays the person's to retry.
    setState({ status: "error", retryable: true, ...said(error) });
  };

  const refuse = (error) => {
    if (error instanceof Error && routedErrors.has(error)) return;
    fail(error);
  };

  const checkOwnsState = () => !actionOwnsState && !downloadOperation && !installOperation;

  updater.on("checking-for-update", () => {
    if (checkOwnsState()) setState({ status: "checking" });
  });
  updater.on("update-not-available", () => {
    staged = null;
    if (checkOwnsState()) setState({ status: "idle" });
  });
  updater.on("error", (error) => {
    // Shared error events do not identify their operation; a failure this call already saw is not counted twice.
    refuse(error);
  });
  updater.on("update-available", (info) => {
    // Only the check this coordinator started leads to a download.
    if (!checkOperation || downloadOperation || installOperation) return;
    void download(info);
  });

  function check(manual = false) {
    if (installOperation) return Promise.resolve();
    if (downloadOperation) return downloadOperation.promise;
    if (checkOperation) {
      if (manual) checkOperation.manual = true;
      return checkOperation.promise;
    }
    if (manual) actionOwnsState = false;
    const operation = { manual, failed: false, promise: null };
    checkOperation = operation;
    try {
      operation.promise = Promise.resolve(updater.checkForUpdates())
        .catch((error) => {
          if (!operation.failed) refuse(error);
        })
        .finally(() => {
          if (checkOperation === operation) checkOperation = null;
        });
    } catch (error) {
      refuse(error);
      checkOperation = null;
      operation.promise = Promise.resolve();
    }
    return operation.promise;
  }

  async function download(info) {
    const image = imageFromFeed(info, baseUrl);
    if (!image) {
      fail(wordedError("native.update.imageNoDmg"));
      return;
    }
    if (!image.sha512) {
      fail(wordedError("native.update.noChecksum"));
      return;
    }
    actionOwnsState = true;
    const operation = { failed: false, promise: null };
    downloadOperation = operation;
    const version = info?.version;
    setState({ status: "downloading", version, releaseNotes: releaseNotesText(info?.releaseNotes), percent: undefined });
    operation.promise = run(operation, image, version);
    await operation.promise;
  }

  async function run(operation, image, version) {
    try {
      const file = join(downloadDir, image.name);
      mkdirSync(downloadDir, { recursive: true, mode: 0o700 });
      // A previous attempt's image may still be here; it is trusted only when the feed's digest still matches.
      if (!(existsSync(file) && hashFile(file) === image.sha512)) await transfer(operation, image, file, version);
      if (operation.failed) return;
      prune(file);
      staged = { version, file };
      setState({ status: "downloaded", version, percent: undefined });
    } catch (error) {
      if (!operation.failed) refuse(error);
    } finally {
      if (downloadOperation === operation) downloadOperation = null;
    }
  }

  async function transfer(operation, image, file, version) {
    const part = `${file}.part`;
    log(`Downloading ${image.url}`);
    const response = await fetchImpl(image.url, { headers: { "Cache-Control": "no-cache" } });
    if (!response || !response.ok) {
      const status = response?.status ?? 0;
      throw Object.assign(new Error(`HTTP ${status}`), { code: `HTTP_${status}` });
    }
    const declared = Number(response.headers?.get?.("content-length"));
    const total = Number.isFinite(declared) && declared > 0 ? declared : image.size;
    const digest = createHash("sha512");
    let copied = 0;
    let percent = -1;
    const progress = () => {
      if (!total) return;
      const next = Math.min(100, Math.floor((copied / total) * 100));
      if (next === percent) return;
      percent = next;
      setState({ status: "downloading", version, percent: next });
    };
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const output = createWriteStream(part, { mode: 0o600 });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          digest.update(chunk);
          copied += chunk.length;
          if (!output.write(chunk)) await once(output, "drain");
          progress();
        }
        await new Promise((resolve, reject) => output.end((error) => (error ? reject(error) : resolve())));
      } catch (error) {
        output.destroy();
        rmSync(part, { force: true });
        throw error;
      }
    } else {
      const bytes = Buffer.from(await response.arrayBuffer());
      digest.update(bytes);
      copied = bytes.length;
      writeFileSync(part, bytes, { mode: 0o600 });
      progress();
    }
    if (operation.failed) {
      rmSync(part, { force: true });
      return;
    }
    if (copied <= 0) {
      rmSync(part, { force: true });
      throw new Error("The update image was empty.");
    }
    if (digest.digest("base64") !== image.sha512) {
      rmSync(part, { force: true });
      throw checksumError();
    }
    renameSync(part, file);
  }

  /** Other versions' images only take up space; the one being offered now is the only one kept. */
  function prune(keep) {
    try {
      for (const name of readdirSync(downloadDir)) {
        const path = join(downloadDir, name);
        if (path === keep) continue;
        if (name.endsWith(".part") || /\.dmg$/i.test(name)) {
          if (statSync(path).isFile()) rmSync(path, { force: true });
        }
      }
    } catch {
    }
  }

  async function install() {
    if (installOperation || downloadOperation || !staged) return;
    actionOwnsState = true;
    const operation = { failed: false };
    installOperation = operation;
    setState({ status: "installing", version: staged.version, message: undefined });
    try {
      if (swap) {
        try {
          await swap(staged.file);
          // The swap runs once the process has left, so the state never settles past "installing".
          quit?.();
          return;
        } catch (error) {
          if (installOperation !== operation) return;
          log(`The staged swap could not start (${error?.message ?? error}); opening the image instead`);
        }
      }
      setState({ status: "installing", version: staged.version, ...updateWords("native.update.imageOpening") });
      const error = await openPath(staged.file);
      if (installOperation !== operation) return;
      if (typeof error === "string" && error.length > 0) {
        log(`Opening the update image failed: ${error}`);
        installOperation = null;
        fail(wordedError("native.update.imageOpenFailed"));
        return;
      }
      const version = staged.version;
      staged = null;
      setState({ status: "handed-off", version, ...updateWords("native.update.imageOpened") });
    } catch (error) {
      if (installOperation === operation) refuse(error);
    } finally {
      if (installOperation === operation) installOperation = null;
    }
  }

  /** A staged image swaps itself in once the app quits, so a quiet moment installs it like a native stage does. */
  function installable() {
    return swap && staged ? { version: staged.version } : null;
  }

  return { check, install, installable };
}
