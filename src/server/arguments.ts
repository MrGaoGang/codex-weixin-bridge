export type ServerCommand = "start" | "foreground" | "stop" | "restart" | "help";

export function parseServerCommand(args: string[]): ServerCommand {
  if (args.length === 0) {
    return "start";
  }
  if (args.length === 1 && (args[0] === "restart" || args[0] === "stop")) return args[0];
  if (args.length === 1 && args[0] === "--foreground") return "foreground";
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return "help";
  }
  throw new Error(`Unknown argument: ${args.join(" ")}. Run codex-weixin --help.`);
}

export function serverHelpText(): string {
  return [
    "Usage: codex-weixin [restart | stop | --foreground]",
    "",
    "Starts codex-weixin in the background; logs: <state directory>/logs/service.log.",
    "",
    "Options:",
    "  restart    Stop then start using the current environment and .env (starts if stopped)",
    "  stop       Stop the service for the configured state directory (safe if stopped)",
    "  --foreground  Run in this terminal for development or a service manager",
    "  -h, --help  Show this help without starting the service",
    "",
    "Environment (also read from .env in the launch directory; exported variables win):",
    "  CODEX_WEIXIN_HOST       Bind address (default: 127.0.0.1)",
    "  CODEX_WEIXIN_ALLOWED_HOSTS  Allowed IPs/domains, separated by commas, spaces or semicolons; optional ports/URLs",
    "  CODEX_WEIXIN_USERNAME   HTTP Basic login username (requires password)",
    "  CODEX_WEIXIN_PASSWORD   HTTP Basic login password (requires username)",
    "  CODEX_WEIXIN_PORT       Web port (default: 8787)",
    "  CODEX_WEIXIN_STATE_DIR  State directory (default: ~/.codex-weixin-bridge)",
    "  CODEX_WEIXIN_OPEN=0     Do not open the browser automatically"
  ].join("\n");
}
