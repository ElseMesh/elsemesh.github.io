# ElseMesh repository guidance

## Network and elevated commands

- Always run network-related commands in an escalated shell, even when they only access localhost. This includes `curl`, HTTP clients, browser/CDP checks, SSH, and Git fetch/push. Use an escalated shell for other commands that require elevated permissions as well.

## Design maturity and compatibility

- ElseMesh is not published yet. Do not optimize for backwards compatibility by default or preserve current behavior solely because it already exists.
- Whenever changing an existing implementation or API, always consider whether it should be redesigned. Prefer the clearest architecture for the intended product, and update callers, tests, and documentation together when changing an unstable interface.

## Evidence and assumptions

- Do not present guessed values or behavior as verified facts. Check source code, runtime evidence, or authoritative documentation first. If a provisional assumption must be used, label it explicitly as an assumption in the relevant code comment or documentation, and record what evidence is still needed to verify it.

## Shared-file commits

- If a commit includes edits from another agent in a shared file, that is allowed. Mention both the requested change and the other agent's change in the commit message.

## Hogwarts bridge build output

- Build the Hogwarts .NET bridge from the external ElseMesh build tree with `--artifacts-path HogwartsBridge.build`. The root `.gitignore` protects this persistent build directory from `cpto` cleanup; do not put generated bridge output under the Hogwarts source sub-repo.
- `cpto` skips nested Git submodules when syncing a parent repository, so sync `worlds/Hogwarts` separately into its matching build-tree path. Use `--update-existing` for edits to files already present in that copy; it preserves target-only files but does not create missing files. For a full subrepo sync, keep build-only files protected by ignore rules in the subrepo.

## Browser process cleanup

- Stop every browser process I own as soon as it is no longer needed for the task, including after a visual check. Identify owned browsers by their dedicated systemd unit, process group, or isolated profile; never kill unrelated user browsers or another agent's browser.

## Transfers to the Flip7

- For large files sent to or from the Flip7, use `rsync` over SSH rather than `scp`. The SSH link can interrupt bulk transfers, while rsync can resume them. Use `--partial --append-verify` for resumable file transfers.
- Keep disposable Android binaries and test state under Termux's `$PREFIX/tmp`; do not overwrite the installed daemon or its persistent ZeroTier identity.
- Transfer to a temporary filename, verify the remote SHA-256 against the build artifact, then rename it into place before execution. Remove the temporary artifacts after the test.
- Use SSH for short remote commands and status checks; use USB ADB when available for stable bulk transfers or screen capture.

## Flip7 display safety

- Never use, control, launch apps onto, or capture the Flip7's physical/main display for development checks.
- Run visual and renderer checks only in an isolated Android virtual display. Prefer `scrcpy --new-display` when available; explicitly target and capture that virtual display ID.
- Never open a normal scrcpy GUI window for Flip7 checks: it can take desktop keyboard/mouse focus. Prefer headless scrcpy with `--no-window --no-control --no-audio --record=<temporary-file>`, which has no window to minimize or focus. If a visible scrcpy window is ever necessary, it must start minimized and must not take keyboard or mouse focus; if scrcpy cannot guarantee both, use the headless mode instead. Create the virtual display without `--start-app`, then launch the app with `adb shell am start --display <logical-display-id> ...`.
- `scrcpy` reports an Android logical display ID, while `screencap -d` requires the corresponding SurfaceFlinger display ID. Map the `scrcpy` virtual display by its `displayName="scrcpy"`/`uniqueId` in `dumpsys SurfaceFlinger --display-id`, then pass only that virtual display ID to `screencap -d`; never use the default capture target or `screencap -a`.
- Start the app on the virtual display and verify its activity reports that display ID before capture. Avoid app launches or input on either physical Flip7 panel.
- If an isolated virtual display cannot be created and targeted, stop the visual check and report the limitation. Do not fall back to the main display.
