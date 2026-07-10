# Native process-loopback audio helper (Variant A)

Implements Variant A of [`about/echo-fix/plan.md`](../../about/echo-fix/plan.md):
a small standalone Windows helper that captures the **system audio mix minus the
Electron process tree** using WASAPI *process loopback*
(`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`).

Because the call participants' voices are played by our own renderer (inside the
Electron process tree), excluding that tree removes them at the OS level — the
deterministic, driver-free equivalent of `restrictOwnAudio`.

## Layout

```
electron/native/process-loopback/
  loopback-capture.cpp   # WASAPI process-loopback capture, PCM -> stdout
  CMakeLists.txt         # build config (Windows 10 SDK 2004+)
  bin/                   # build output; process-loopback-capture.exe lands here
```

## Requirements

- Windows 10 version **2004 (build 19041)** or newer, or Windows 11.
- Windows 10 SDK **10.0.19041.0** or newer.
- Visual Studio 2022 Build Tools (MSVC) + CMake.

## Build

```powershell
cd electron/native/process-loopback
cmake -B build -A x64
cmake --build build --config Release
# -> electron/native/process-loopback/bin/process-loopback-capture.exe
```

## Runtime contract

- Invocation: `process-loopback-capture.exe <electron_pid>`
- **STDOUT**: continuous raw PCM — interleaved **float32, 48000 Hz, 2 channels**.
- **STDERR**: one JSON line `{"type":"format",...}` then diagnostics.
- Exits on `SIGINT`/`CTRL_CLOSE` or when its stdout pipe is closed by the parent.

## Packaging

`electron-builder.yml` ships the built `.exe` via `extraResources` so it lands in
`process.resourcesPath` inside the installed app. If the binary is missing (or the
OS is older than build 19041), `electron/main.js` reports the feature as
unsupported and the renderer falls back to the previous loopback + AEC path — no
regression.
