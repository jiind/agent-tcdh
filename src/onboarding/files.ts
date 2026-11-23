import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** A configuration diagnostic whose message contains no file contents or system error details. */
export class ConfigurationFileError extends Error {}

/** Read a bounded regular configuration file without following symbolic links. */
export async function readConfigText(path: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) {
    throw new ConfigurationFileError("Configuration must be a regular file no larger than 1 MiB.");
  }
  const bytes = await readFile(path);
  if (bytes.length > 1_048_576) {
    throw new ConfigurationFileError("Configuration files must not exceed 1 MiB.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ConfigurationFileError("Configuration files must contain valid UTF-8 text.");
  }
}

/** Atomically create or replace a configuration after checking the observed contents and backing them up. */
export async function writeConfigText(path: string, content: string, expected?: string) {
  // 1. Stage a private file beside its destination and serialize cooperating writers with a lock.
  if (Buffer.byteLength(content, "utf8") > 1_048_576) {
    throw new ConfigurationFileError("Configuration files must not exceed 1 MiB.");
  }
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const lockPath = destination + ".agent-tcdh.lock";
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ConfigurationFileError("Another configuration write is in progress. Retry after it finishes.");
    }
    throw error;
  }
  let staging: string | undefined;
  try {
    if (await readConfigText(destination) !== expected) {
      throw new ConfigurationFileError("Configuration changed since it was read. Preview again before writing.");
    }
    if (content === expected) {
      return { path: destination, changed: false };
    }
    staging = await mkdtemp(join(dirname(destination), ".agent-tcdh-config-"));
    const temporary = join(staging, "config");
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }

    // 2. Preserve the exact previous contents before a replacement; never overwrite an unobserved file.
    let backup: string | undefined;
    if (expected !== undefined) {
      backup = destination + ".agent-tcdh-backup-" + randomUUID();
      const previous = await open(backup, "wx", 0o600);
      try {
        await previous.writeFile(expected, "utf8");
        await previous.sync();
      } finally {
        await previous.close();
      }
    }
    if (await readConfigText(destination) !== expected) {
      throw new ConfigurationFileError("Configuration changed during the write. The existing file was preserved.");
    }
    if (expected === undefined) {
      await link(temporary, destination);
    } else {
      await rename(temporary, destination);
    }
    return { path: destination, changed: true, ...(backup ? { backup } : {}) };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
    if (staging) {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
