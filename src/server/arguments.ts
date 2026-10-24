export type ServerCommand = "start" | "help";

export function parseServerCommand(args: string[]): ServerCommand {
  if (args.length === 0) {
    return "start";
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return "help";
  }
  throw new Error(`Unknown argument: ${args.join(" ")}. Run codex-weixin --help.`);
}

export function serverHelpText(): string {
  return [
    "Usage: codex-weixin",
    "",
    "Starts the local codex-weixin Web service.",
    "",
    "Options:",
    "  -h, --help  Show this help without starting the service",
    "",
    "Environment:",
    "  CODEX_WEIXIN_HOST       Bind address (default: 127.0.0.1)",
    "  CODEX_WEIXIN_ALLOWED_HOSTS  Comma-separated allowed IPs/hostnames (without ports)",
    "  CODEX_WEIXIN_USERNAME   HTTP Basic login username (requires password)",
    "  CODEX_WEIXIN_PASSWORD   HTTP Basic login password (requires username)",
    "  CODEX_WEIXIN_PORT       Web port (default: 8787)",
    "  CODEX_WEIXIN_STATE_DIR  State directory (default: ~/.codex-weixin)",
    "  CODEX_WEIXIN_OPEN=0     Do not open the browser automatically"
  ].join("\n");
}
