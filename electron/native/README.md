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

Установка Build Tools одной командой:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.CMake.Project --includeRecommended"
```

## Build

```powershell
pnpm run build:native
# -> electron/native/process-loopback/bin/process-loopback-capture.exe
```

Скрипт [`scripts/build-native-helper.mjs`](../../scripts/build-native-helper.mjs)
сам находит `cmake.exe`. Это важно, потому что CMake из состава Visual Studio
Build Tools **не прописывается в системный PATH** — из обычного PowerShell
`cmake` не находится. Порядок поиска:

1. `cmake` в `PATH`;
2. установки Visual Studio через `vswhere.exe`
   (`<VS>\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe`);
3. отдельная установка в `C:\Program Files\CMake\bin`.

Перезагрузка после установки Build Tools не требуется. Эквивалент вручную — из
меню Пуск открыть **x64 Native Tools Command Prompt for VS 2022** и выполнить:

```
cmake -S electron/native/process-loopback -B electron/native/process-loopback/build -A x64
cmake --build electron/native/process-loopback/build --config Release
```

`-A x64` обязателен: helper должен быть 64-битным, иначе `check:native` его
отклонит.

## Runtime contract

- Invocation: `process-loopback-capture.exe <electron_pid>`
- **STDOUT**: continuous raw PCM — interleaved **float32, 48000 Hz, 2 channels**.
- **STDERR**: one JSON line `{"type":"format",...}` then diagnostics.
- Exits on `SIGINT`/`CTRL_CLOSE` or when its stdout pipe is closed by the parent.

## Packaging

`electron-builder.yml` ships the built `.exe` via `extraResources` so it lands in
`process.resourcesPath` inside the installed app. At **runtime**, if the binary is
missing (or the OS is older than build 19041), `electron/main.js` reports the
feature as unsupported and the renderer falls back to the previous loopback + AEC
path — no regression.

### Сборка обязательна (build gate)

electron-builder **молча** игнорирует отсутствующие `extraResources`: glob ничего
не находит — и установщик собирается без helper'а. Поэтому `pnpm run dist` и
`pnpm run dist:dir` обёрнуты проверкой
[`scripts/check-native-helper.mjs`](../../scripts/check-native-helper.mjs):

- **до** упаковки: `bin/process-loopback-capture.exe` существует, не заглушка
  (> 8 KB) и является валидным **x64** PE-файлом;
- **после** упаковки: тот же бинарь лежит в
  `release/win-unpacked/resources/native/` с совпадающим размером, а установщик
  `.exe` действительно создан.

Любая из проверок валит сборку с ненулевым кодом выхода. Проверить отдельно:

```powershell
pnpm run check:native
```
