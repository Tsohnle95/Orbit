import type { AppUpdater } from "electron-updater";
import type { MiraAppUpdateResult, MiraAppUpdateStatus } from "@shared/types";

export interface MiraAppUpdater {
  check(): Promise<MiraAppUpdateStatus>;
  update(onProgress?: (message: string) => void): Promise<MiraAppUpdateResult>;
  installAndRestart(): void;
}

export function createDisabledMiraAppUpdater(currentVersion: string): MiraAppUpdater {
  const message = "GitHub release updates are disabled in local development and test builds.";
  return {
    async check() {
      return { state: "disabled", currentVersion, message };
    },
    async update() {
      return { ok: false, updated: false, currentVersion, message };
    },
    installAndRestart() {}
  };
}

export function createMiraAppUpdater(updater: AppUpdater, currentVersion: string): MiraAppUpdater {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;

  let updateInProgress = false;

  async function check(): Promise<MiraAppUpdateStatus> {
    try {
      const result = await updater.checkForUpdates();
      if (!result) {
        return {
          state: "blocked",
          currentVersion,
          message: "Mira could not check GitHub Releases because this app has no release update feed."
        };
      }
      const latestVersion = result.updateInfo.version;
      return result.isUpdateAvailable
        ? { state: "available", currentVersion, latestVersion }
        : { state: "current", currentVersion, latestVersion };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        state: "blocked",
        currentVersion,
        message: `Could not check GitHub Releases for Mira updates: ${detail}`
      };
    }
  }

  async function update(onProgress?: (message: string) => void): Promise<MiraAppUpdateResult> {
    if (updateInProgress) {
      return { ok: false, updated: false, currentVersion, message: "A Mira update is already running." };
    }
    updateInProgress = true;
    try {
      onProgress?.("Checking GitHub Releases for a Mira update…");
      const status = await check();
      if (status.state === "blocked" || status.state === "disabled") {
        return { ok: false, updated: false, currentVersion, message: status.message };
      }
      if (status.state === "current") {
        return {
          ok: true,
          updated: false,
          currentVersion,
          latestVersion: status.latestVersion,
          message: `Mira ${currentVersion} is the latest published release.`
        };
      }

      onProgress?.(`Downloading Mira ${status.latestVersion} from GitHub Releases…`);
      const reportDownloadProgress = (progress: { percent: number }): void => {
        const percent = Number.isFinite(progress.percent)
          ? Math.max(0, Math.min(100, Math.floor(progress.percent)))
          : null;
        onProgress?.(percent === null
          ? `Downloading Mira ${status.latestVersion} from GitHub Releases…`
          : `Downloading Mira ${status.latestVersion} from GitHub Releases (${percent}%)…`);
      };
      updater.on("download-progress", reportDownloadProgress);
      try {
        await updater.downloadUpdate();
      } finally {
        updater.removeListener("download-progress", reportDownloadProgress);
      }

      onProgress?.("Release downloaded. Installing it and restarting Mira…");
      return {
        ok: true,
        updated: true,
        currentVersion,
        latestVersion: status.latestVersion,
        message: `Mira ${status.latestVersion} is downloaded and ready to install.`
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        updated: false,
        currentVersion,
        message: `Mira could not download the release update. ${detail}`
      };
    } finally {
      updateInProgress = false;
    }
  }

  return {
    check,
    update,
    installAndRestart() {
      updater.quitAndInstall(false, true);
    }
  };
}
