import { startBackgroundService } from "./daemon.js";
import { readServiceStatus, stopService, type ServiceStatus } from "./restart-control.js";
import type { UpdateService } from "./update-manager.js";

export type CliUpdateOptions = {
  root: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  entryPath: string;
  installable: boolean;
  updater: Pick<UpdateService, "check" | "installLatest">;
};

export type CliUpdateDependencies = {
  readStatus: (root: string) => Promise<ServiceStatus | undefined>;
  stop: (root: string) => Promise<void>;
  start: (options: {
    root: string;
    entryPath: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<ServiceStatus & { logPath: string }>;
  log: (message: string) => void;
};

const defaultDependencies: CliUpdateDependencies = {
  readStatus: readServiceStatus,
  stop: stopService,
  start: startBackgroundService,
  log: (message) => console.log(message)
};

export async function runCliUpdate(
  options: CliUpdateOptions,
  dependencies: Partial<CliUpdateDependencies> = {}
): Promise<void> {
  if (!options.installable) {
    throw new Error("CLI update is only supported for an installed npm package. For a source checkout, update Git, run npm install and npm run build, then restart.");
  }

  const status = await options.updater.check(true);
  if (status.error || !status.latestVersion) {
    throw new Error("Unable to verify the latest codex-weixin version");
  }

  const { readStatus, stop, start, log } = { ...defaultDependencies, ...dependencies };
  const currentService = await readStatus(options.root);
  const startOptions = {
    root: options.root,
    entryPath: options.entryPath,
    cwd: options.cwd,
    env: options.env
  };

  if (!status.updateAvailable) {
    if (!currentService) {
      const started = await start(startOptions);
      log(`codex-weixin is already up to date (${status.currentVersion}); started in background (PID ${started.pid}) at ${started.url}`);
    } else {
      log(`codex-weixin is already up to date (${status.currentVersion})`);
    }
    return;
  }

  await stop(options.root);
  let result: Awaited<ReturnType<UpdateService["installLatest"]>>;
  try {
    result = await options.updater.installLatest();
  } catch (error) {
    if (currentService) {
      try {
        const recovered = await start(startOptions);
        log(`codex-weixin update failed (${errorMessage(error)}); restarted the service from the installed package (PID ${recovered.pid}) at ${recovered.url}`);
      } catch (restartError) {
        throw new AggregateError(
          [error, restartError],
          `Update failed: ${errorMessage(error)}; service recovery failed: ${errorMessage(restartError)}`
        );
      }
    }
    throw error;
  }

  const started = await start(startOptions);
  log(`codex-weixin updated to ${result.version}; started in background (PID ${started.pid}) at ${started.url}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
