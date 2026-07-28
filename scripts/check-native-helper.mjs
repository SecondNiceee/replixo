#!/usr/bin/env node
/**
 * Гарантирует, что нативный helper "виртуального аудиокабеля"
 * (process-loopback-capture.exe) реально попадает в сборку.
 *
 * Проблема: electron-builder молча игнорирует отсутствующие `extraResources`
 * (glob просто ничего не находит), поэтому `pnpm run dist` успешно собирал .exe
 * БЕЗ helper'а. Этот скрипт делает такую сборку невозможной.
 *
 * Использование:
 *   node scripts/check-native-helper.mjs --pre     # до electron-builder
 *   node scripts/check-native-helper.mjs --post    # после electron-builder (nsis)
 *   node scripts/check-native-helper.mjs --post --dir  # после --dir сборки
 */

import { existsSync, statSync, openSync, readSync, closeSync, readdirSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const ROOT = path.resolve(import.meta.dirname, "..")

const SOURCE_EXE = path.join(
  ROOT,
  "electron",
  "native",
  "process-loopback",
  "bin",
  "process-loopback-capture.exe",
)
const PACKED_EXE = path.join(ROOT, "release", "win-unpacked", "resources", "native", "process-loopback-capture.exe")
const RELEASE_DIR = path.join(ROOT, "release")

const MIN_SIZE_BYTES = 8 * 1024

const args = process.argv.slice(2)
const mode = args.includes("--post") ? "post" : "pre"
const dirOnly = args.includes("--dir")

function fail(title, lines) {
  console.error(`\n[native-helper] ОШИБКА: ${title}\n`)
  for (const line of lines) console.error(`  ${line}`)
  console.error("")
  process.exit(1)
}

const BUILD_HINT = [
  "Собери helper перед упаковкой (Windows, VS 2022 Build Tools + CMake, Win10 SDK 19041+):",
  "",
  "    cd electron/native/process-loopback",
  "    cmake -B build -A x64",
  "    cmake --build build --config Release",
  "",
  "Подробности: electron/native/README.md",
]

/** Проверяет, что файл — валидный 64-битный Windows PE, а не заглушка/текст. */
function assertValidWindowsExe(file, label) {
  const size = statSync(file).size
  if (size < MIN_SIZE_BYTES) {
    fail(`${label} слишком маленький (${size} байт) — похоже на заглушку, а не на реальный бинарь.`, [
      `Файл: ${file}`,
      "",
      ...BUILD_HINT,
    ])
  }

  const fd = openSync(file, "r")
  try {
    const head = Buffer.alloc(0x40)
    readSync(fd, head, 0, head.length, 0)

    if (head[0] !== 0x4d || head[1] !== 0x5a) {
      fail(`${label} не является Windows-исполняемым файлом (нет подписи "MZ").`, [`Файл: ${file}`, "", ...BUILD_HINT])
    }

    const peOffset = head.readUInt32LE(0x3c)
    const peHeader = Buffer.alloc(6)
    readSync(fd, peHeader, 0, peHeader.length, peOffset)

    if (peHeader.toString("ascii", 0, 4) !== "PE\0\0") {
      fail(`${label} повреждён: не найден PE-заголовок.`, [`Файл: ${file}`, "", ...BUILD_HINT])
    }

    const machine = peHeader.readUInt16LE(4)
    if (machine !== 0x8664) {
      fail(`${label} собран не под x64 (machine=0x${machine.toString(16)}), а сборка идёт под win/x64.`, [
        `Файл: ${file}`,
        "",
        "Пересобери с архитектурой x64:  cmake -B build -A x64",
      ])
    }
  } finally {
    closeSync(fd)
  }
}

if (mode === "pre") {
  if (!existsSync(SOURCE_EXE)) {
    fail("нативный helper (виртуальный аудиокабель) не собран — сборка прервана.", [
      "Не найден обязательный файл:",
      `  ${path.relative(ROOT, SOURCE_EXE)}`,
      "",
      "Он объявлен в electron-builder.yml -> extraResources, но electron-builder",
      "молча пропускает отсутствующие ресурсы, поэтому проверка сделана явной.",
      "",
      ...BUILD_HINT,
    ])
  }

  assertValidWindowsExe(SOURCE_EXE, "process-loopback-capture.exe")

  console.log(
    `[native-helper] OK: ${path.relative(ROOT, SOURCE_EXE)} (${statSync(SOURCE_EXE).size} байт) готов к упаковке.`,
  )
} else {
  if (!existsSync(PACKED_EXE)) {
    fail("helper отсутствует в упакованном приложении.", [
      "Ожидался файл:",
      `  ${path.relative(ROOT, PACKED_EXE)}`,
      "",
      "Проверь секцию extraResources в electron-builder.yml.",
    ])
  }

  assertValidWindowsExe(PACKED_EXE, "resources/native/process-loopback-capture.exe")

  const sourceSize = statSync(SOURCE_EXE).size
  const packedSize = statSync(PACKED_EXE).size
  if (sourceSize !== packedSize) {
    fail("упакованный helper не совпадает с собранным бинарём.", [
      `${path.relative(ROOT, SOURCE_EXE)}: ${sourceSize} байт`,
      `${path.relative(ROOT, PACKED_EXE)}: ${packedSize} байт`,
    ])
  }

  if (!dirOnly) {
    const installers = existsSync(RELEASE_DIR)
      ? readdirSync(RELEASE_DIR).filter((f) => f.toLowerCase().endsWith(".exe"))
      : []
    if (installers.length === 0) {
      fail("установщик .exe не найден в release/.", ["Похоже, electron-builder не завершил сборку NSIS-таргета."])
    }
    console.log(`[native-helper] OK: установщик собран (${installers.join(", ")}) и содержит helper.`)
  } else {
    console.log("[native-helper] OK: helper присутствует в release/win-unpacked/resources/native/.")
  }
}
