# ElseMesh repository guidance

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
