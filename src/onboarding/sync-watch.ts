import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { HubClient } from "../client.js";
import { importProfilesPath, readImportProfile } from "./import-profiles.js";
import { syncLocalWorkflow } from "./import-workflow.js";

/** Poll explicitly pinned source files and report read-only synchronization plans. */
export async function watchImportSources(client: HubClient, hub: string, input: {
  profile: string; profilesFile?: string | undefined; prune?: boolean | undefined;
  interval: number; signal: AbortSignal;
}, notify: (event: Record<string, unknown>) => void): Promise<void> {
  async function fingerprint() {
    const profile = await readImportProfile(input.profile, input.profilesFile);
    return JSON.stringify(await Promise.all([importProfilesPath(input.profilesFile), ...profile.sources.map((source) => source.path)].map(async (path) => {
      try {
        const { dev, ino, size, mtimeMs, ctimeMs } = await stat(path);
        return [path, dev, ino, size, mtimeMs, ctimeMs];
      } catch (error) {
        return [path, (error as NodeJS.ErrnoException).code];
      }
    })));
  }
  let previous: string | undefined;
  let failed = false;
  while (!input.signal.aborted) {
    try {
      const current = await fingerprint();
      if (current !== previous || failed) {
        const report = await syncLocalWorkflow(client, hub, { profile: input.profile, profilesFile: input.profilesFile, prune: input.prune });
        const event = previous === undefined ? "initial" : current !== previous ? "source-changed" : "recovered";
        notify({ event, ...report });
        previous = current;
        failed = false;
      }
    } catch {
      if (!failed) {
        notify({ event: "preview-unavailable", profile: input.profile, applied: false,
          message: "Check the import profile, source paths, and hub connection. The watcher will retry." });
        failed = true;
      }
    }
    try {
      await delay(input.interval, undefined, { signal: input.signal });
    } catch (error) {
      if (!input.signal.aborted) {
        throw error;
      }
    }
  }
}
