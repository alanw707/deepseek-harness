# Run the local command center

English | [中文](command-center.zh.md)

Software Factory registers explicitly selected WSL project folders and launches new independent Pi, Codex, or OpenClaw runs for one local user. The shipped `web` and `web-codex` profiles include it by default. The Host API binds only to `127.0.0.1`; Discord uses an outbound bot connection and does not expose an inbound public server. Software Factory renders inside the existing DSH Web shell: `/` remains DSH Chat with its sessions, workspaces, model and permission controls, tools, plans, workflows, and settings; use the Software Factory sidebar link or `Ctrl+Shift+T` to enter the executor workspace.

## Check the executors

Install and authenticate each executor as the same WSL user that runs the command center. Confirm `pi --version`, `codex --version`, and `openclaw --version`, then run one benign headless command through each executor before enabling Discord. Pi must have working `openai-codex` OAuth (`pi auth check --provider openai-codex --no-refresh`), and Codex must have a valid auth file (`codex login status`). The command center stages that Codex credential source without refresh authority, copies it into a writable per-run `CODEX_HOME` under the sandbox temporary area, and never writes the source; an expired access token fails the task rather than rotating credentials used by an existing app session. OpenClaw keeps its isolated supported authentication. No executor attaches to an existing app session.

Keep authentication in executor user configuration outside registered projects. Never put OAuth material, API keys, Discord bot tokens, or OpenClaw credentials in this repository, a registered project, a task instruction, or task output.

Set `DSH_COMMAND_CENTER_OPENCLAW_CONFIG` to an isolated OpenClaw task configuration outside every registered project, or create the default `$DSH_HOME/command-center/openclaw-task.json`. Its parent directory should be mode `0700` and the file mode `0600`; omit per-agent `agents.entries` and legacy `agents.list`, because the command center refuses a configuration unless one non-overridable default enforces Docker isolation, a Docker `user` equal to the command-center host user's numeric `uid:gid`, read-write access only to the selected workspace, no container network, a read-only root filesystem, dropped capabilities, no elevation, and only sandbox filesystem/runtime tools.

Optional `DSH_COMMAND_CENTER_PI_COMMAND`, `DSH_COMMAND_CENTER_PI_MODEL`, `DSH_COMMAND_CENTER_CODEX_COMMAND`, `DSH_COMMAND_CENTER_CODEX_AUTH`, `DSH_COMMAND_CENTER_OPENCLAW_COMMAND`, and `DSH_COMMAND_CENTER_DOCKER_COMMAND` values select installed executable paths, the Pi model, and the Codex auth source. The Codex auth source defaults to `$CODEX_HOME/auth.json` or `~/.codex/auth.json`. Pi reads a cached bearer token through `auth check --no-refresh --credentials --json` and receives it through an ephemeral provider override. Pi and Codex write required per-run state only under the sandbox temporary area; Codex receives an auth copy without the refresh token, so its permanent auth store cannot be rotated by a command-center run. Credential values are retained for exact output redaction, private staging and temporary runtime state are removed after settlement, and Pi file tools block every path outside the copied project.

Set `DSH_COMMAND_CENTER_COPIES` to an existing owner-only directory outside every registered project; it defaults to `~/.dsh-command-center/task-copies`. Copy preparation rejects symlinks and special files, excludes credential/configuration names and `node_modules`, and retains a private baseline. The profile limits preparation to 100,000 entries and 1 GiB and limits complete before/after change review to 1 MiB; adjust `copies` or `reviewLimitBytes` in the profile patch when needed. If Codex is installed outside minimal system paths, set `DSH_COMMAND_CENTER_CODEX_READ_ROOTS` to a JSON array of absolute static runtime directories required by that installation. Do not grant credential directories.

## Configure a dedicated Discord bot

Create a dedicated Discord application and bot; do not reuse the OpenClaw bot. Enable the Message Content privileged intent, invite the bot only to intended servers, and grant only View Channels, Send Messages, and Read Message History in intended channels. Direct messages from the configured controlling user do not need a server or channel allowlist. Enable Discord Developer Mode and copy the controlling user ID plus every allowed server and channel ID.

Supply the token outside source control and comma-separated exact allowlists through the launch environment:

```sh
read -rsp 'Discord bot token: ' DSH_COMMAND_CENTER_DISCORD_TOKEN; echo
export DSH_COMMAND_CENTER_DISCORD_TOKEN
export DSH_COMMAND_CENTER_DISCORD_USER_ID='123456789012345678'
export DSH_COMMAND_CENTER_DISCORD_GUILD_IDS='234567890123456789'
export DSH_COMMAND_CENTER_DISCORD_CHANNEL_IDS='345678901234567890'
# Optional; defaults to !cc
export DSH_COMMAND_CENTER_DISCORD_PREFIX='!cc'
```

For repeated starts, place these values in a mode-`0600` environment file outside repositories and load it through the local process manager. Omit both guild and channel values for direct-message-only mode. Discord is disabled only when all Discord fields are absent; a partial configuration or malformed Snowflake ID fails profile loading rather than weakening authorization.

## Start locally

The shipped Web profile already includes the command center. Start the loopback profile from the repository:

```sh
install -d -m 0700 "${DSH_COMMAND_CENTER_COPIES:-$HOME/.dsh-command-center/task-copies}"
pnpm dsh --profile web --no-open --port 3181
```

Open the exact URL printed by `dsh web` in the WSL browser environment. That authenticated URL opens the DSH shell; choose Software Factory in the sidebar or press `Ctrl+Shift+T` for executor work, or open `/command-center` after authentication. Do not forward this port, bind the Web profile to another interface, or publish it through a reverse proxy. The route uses the shell's Web authentication, then creates an HttpOnly SameSite dashboard session; mutation endpoints require that session and its CSRF token.

## Use the dashboard

Register only folders that this WSL user intends agents to edit. Registration is a durable command-center approval; shared DSH workspaces do not become projects automatically, and parent/child project overlap is rejected. In Software Factory, choose a project and executor, write one bounded instruction, and select **Continue to review**. Inspect the named project and request, then select **Approve & start** once; this consumes launch approval and dispatches the private run. Pending, queued, and running tasks expose cancellation, and the route refreshes task state without closing output or change details.

Cancellation requests whole-process-tree termination and reports `cancelled` only after the owned tree exits. Work for the same or overlapping project path is serialized, while unrelated registered projects may run independently.

## Use Discord

The dedicated bot accepts commands from the configured user in direct messages, or when the user, server, and channel match the configured guild allowlists:

```text
!cc help
!cc projects
!cc run <project-id> <pi|codex|openclaw> <task instruction>
!cc status [task-id]
!cc cancel <task-id>
```

`run` durably creates a task and acknowledges its ID, but leaves it in `pending-approval`; Discord cannot approve or dispatch a task. Use the dashboard to inspect the exact instruction and choose **Approve & start**. The bot reports terminal success, failure, cancellation, or interruption in the originating guild channel or direct message and persists successful notification delivery across restart.

## Apply the approval policy

Executors receive a private project copy, not the original project, as their working directory. Pi has no shell and its file tools are restricted to that copy; Codex uses named permissions that deny the original and private snapshot files while allowing workspace edits without child-command networking; OpenClaw receives the copy as its container workspace. An executor without full enforced confinement is refused.

Launch approval authorizes execution against the isolated copy, not application to the original project. After a successful run, select **Review exact changes**, and inspect every complete UTF-8 before/after value or directory mode. **Apply these exact changes** records and consumes a second durable approval bound to the displayed SHA-256 digest. Apply attempts are globally serialized and reject when an affected original path changed, disappeared, appeared, changed type or permissions, or has multiple hard links. Pushes, network deployments, access to `.git`, protected credential paths, binary changes, and file/directory type replacement remain blocked rather than bypassing review.

## Recover after restart

Project approvals and task history survive command-center restart. Tasks persisted as `running` or `cancelling` become `interrupted` and are never silently restarted; Discord-origin interrupted tasks receive a terminal notification after the bot reconnects. An apply operation that loses the command-center process becomes `apply-interrupted` and is never retried; inspect the original project and retained change set manually before continuing. Inspect any failure or interruption detail, confirm no owned process remains, then create and approve a new task if retry is appropriate.
