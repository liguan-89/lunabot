export { HEADLESS_VERBS as HEADLESS_VERB_NAMES } from "./headless/args.ts";

export const HEADLESS_USAGE = `Drive a running workspace (scripts, CI, other agents):
  lunabot doctor                    check the server answers and an engine is ready
  lunabot doctor --host             check this Linux machine can run a server (exit 7 if not)
  lunabot bots | channels | models  your bots, your rooms, the engines and their models
  lunabot run BOT "do this"         give a bot one job and wait until it and every teammate it asked are done
  lunabot send BOT "text"           send one message and return at once
  lunabot wait BOT                  wait on work already running
  lunabot messages BOT              the latest messages of a conversation
  lunabot interrupt BOT [--tree]    press Stop (--tree: and every teammate on its job)
  lunabot export BOT --out DIR      write a job's transcripts, files and screens to DIR
  lunabot events [--job THREAD]     the server's live events as JSON lines
  lunabot team apply FILE           make the workspace match a team file (team export writes one)
  lunabot engine set claude --key-env ANTHROPIC_API_KEY   give it an engine without a screen
  lunabot connect URL --code CODE --out FILE              get a token for a workspace elsewhere
  lunabot token create NAME --out FILE [--expires 90d]    a token for CI that ends on its date (token list, token revoke ID)
  lunabot new-bot | new-channel | set-model | edit | mcp

  Server: --url URL (or DEXBOT_URL), --port N (or OMB_PORT), else this computer's.
  Token: DEXBOT_TOKEN or --token-file FILE. --json prints one JSON document;
  progress goes to stderr (--quiet drops it). lunabot help VERB for the details.`;

/** The usage text, its commands written the way this CLI was started (`npx lunabot …`). */
export function usage(prefix = "lunabot"): string {
  return USAGE.split("\n").map((line) => line.replace(/^(\s+)lunabot(?= )/, `$1${prefix}`)).join("\n");
}

export const USAGE = `lunabot — your team of AI bots, ready in a few steps

  lunabot                         set up once, then open your workspace
  lunabot setup [--data-dir DIR]
  lunabot start [the same options as serve]
  lunabot serve [--port 8799] [--data-dir DIR] [--label NAME]
                    [--public-url https://host | --domain HOST | --tunnel | --tailscale] [--lan] [--relay]
  lunabot pair  [--label NAME] [--phone [ios|android]] [--ttl 24h] [--public-url https://host]
  lunabot devices [revoke ID]
  lunabot status
  lunabot --version
  lunabot login [--email you@example.com] [--relay]
  lunabot logout
  lunabot access list | add EMAIL [--chat-only] | remove EMAIL
  lunabot service install [the same way-in options as serve] [--port N] [--data-dir DIR] | uninstall
                    [--sentinel]   (the health scan below, every two minutes, instead of the server)
  lunabot sentinel [--data-dir DIR] [--out DIR] [--once] [--json]   (read-only health scan; see --help)
  lunabot browser install [--with-deps] | status
  lunabot fleet init --domain HOST [--operator USER] | create NAME --admin EMAIL [--member EMAIL] [--brand FILE]
                    [--anthropic-key-file FILE] [--cap USD] [--license-key KEY] [--memory 1G]
                  | list | users NAME add|remove EMAIL [--chat-only] | suspend NAME | resume NAME
                  | delete NAME --yes [--keep-data] | upgrade   (all take --dry-run)
                  | agent [--socket PATH] [--group USER]   (root; installed by init --operator)

setup   choose AI access and optional phone access; keep existing bots and chats
start   same as lunabot: use your saved settings and open the workspace
serve   starts the server without prompts; in a terminal it prints a pairing
        code, the link to paste into the desktop app (＋ → Connect to a
        server) and a QR for a phone
pair    a new pairing code for the running server, with its link and QR
        (--phone: chat and approvals only; --ttl keeps it open up to 24h,
        still single use)
devices lists paired devices; "devices revoke ID" signs one out;
        "devices routes ID local" keeps one on this machine's own networks
        (Wi-Fi and tailnet) and off Luna Bot Relay
status  the running server, the address others reach it at, and whether
        that address answers as this server
login   signs this machine in to a Luna Bot account (an emailed code)
        and reserves its public address for --tunnel; with --relay it
        reserves none, for serve --relay
logout  releases that address and signs out
access  who may sign in with an emailed code at /pair: an address or
        @domain; --chat-only gives chat and approvals without settings.
        Takes effect at once, no restart.
service keep the server running across reboots: writes a systemd unit
        (Linux) or a launchd agent (macOS) for the same serve options and
        prints the commands that install it. Run from npx, it first
        installs a copy of this version next to your data for the service.
browser install: the bots' browser engine (agent-browser, pinned) into the
        data dir, and Chrome for Testing into the user's browser cache.
        --with-deps also installs
        the Linux libraries Chrome needs (run as root once). Then run
        browser install as the user running serve, from that user's home.
        status: what the current user and data directory have.
fleet   many client workspaces on one Linux server, each its own account,
        service, data folder, brand, sign-in list and keys at NAME.HOST
        behind the system Caddy. Plans are printed unless run as root;
        --dry-run always prints. Install the package permanently first.
        init --operator USER also installs the fleet agent, a root service
        on a Unix socket only USER may open, so the workspace running as
        USER manages the others from Settings → Installations.

Ways in (pick one; --lan can join any):
--public-url you already have HTTPS in front (cloudflared, Caddy, nginx):
             the link uses that address, after checking it reaches this
             server. http:// is accepted only for a private network address.
--lan        this network only, plain http: listens on this machine's
             private addresses and answers nobody on the open internet
--tailscale  serve over your tailnet: Tailscale terminates HTTPS and the
             link uses this machine's MagicDNS name (needs Tailscale signed in
             and HTTPS certificates enabled for the tailnet); the share ends
             when serve stops
--tunnel     serve at a public https://c-… address through a
             Cloudflare tunnel: no domain, no proxy, no open port. Run
             \`lunabot login\` once on this machine first.
--domain     serve at https://HOST on your own domain: a pinned Caddy is
             downloaded once and run alongside the server, and gets the
             certificate itself. Point the domain's DNS at this machine and
             open ports 80 and 443.

--relay      phones only, and it can join any of the above except --tunnel:
             the Luna Bot phone app pairs by QR through Luna Bot Relay,
             end-to-end encrypted, with no address, open port or VPN. Run
             \`lunabot login --relay\` once on this machine first. Not on a
             machine with a tunnel address: the relay stays off there.

--no-open   do not open a browser window
--no-pair   do not print a pairing code
--local     start locally this time, ignoring saved remote-access settings

${HEADLESS_USAGE}

Install once with \`npm install -g lunabot\`, then type \`lunabot\`.
Or run without a global install: \`npx lunabot\`. Node 24+ is required.
`;
