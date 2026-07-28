#!/usr/bin/env node
/**
 * Сборка нативного helper'а process-loopback-capture.exe.
 *
 * Зачем скрипт вместо двух вызовов cmake в package.json:
 * CMake, который ставится вместе с Visual Studio Build Tools, НЕ прописывается
 * в системный PATH. Он доступен только внутри "x64 Native Tools Command Prompt
 * for VS 2022". Из обычного PowerShell `cmake` не находится, и сборка падает с
 * "cmake не является внутренней или внешней командой".
 *
 * Поэтому мы ищем cmake.exe сами: сначала в PATH, затем через vswhere в
 * установках Visual Studio, затем в стандартных местах отдельной установки CMake.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const SOURCE_DIR = path.join(PROJECT_ROOT, 'electron', 'native', 'process-loopback')
const BUILD_DIR = path.join(SOURCE_DIR, 'build')

const RESET = '\u001B[0m'
const RED = '\u001B[31m'
const GREEN = '\u001B[32m'
const YELLOW = '\u001B[33m'
const DIM = '\u001B[2m'

function fail(message, hint) {
  console.error(`\n${RED}ОШИБКА: ${message}${RESET}\n`)
  if (hint) console.error(`${hint}\n`)
  process.exit(1)
}

/** Проверяем, что бинарь cmake реально запускается. */
function isWorkingCmake(cmakePath) {
  const probe = spawnSync(cmakePath, ['--version'], { encoding: 'utf8' })
  return probe.status === 0
}

/** Ищем установки Visual Studio через vswhere и достаём вложенный CMake. */
function cmakeFromVisualStudio() {
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!existsSync(vswhere)) return []

  // -products * охватывает и Build Tools, и Community/Professional/Enterprise.
  const result = spawnSync(
    vswhere,
    ['-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath', '-nologo'],
    { encoding: 'utf8' },
  )
  if (result.status !== 0 || !result.stdout) return []

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((installPath) =>
      path.join(installPath, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe'),
    )
}

function resolveCmake() {
  // 1. PATH — если пользователь в "x64 Native Tools Command Prompt" или поставил CMake отдельно.
  if (isWorkingCmake('cmake')) return 'cmake'

  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const candidates = [
    ...cmakeFromVisualStudio(),
    path.join(programFiles, 'CMake', 'bin', 'cmake.exe'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate) && isWorkingCmake(candidate)) return candidate
  }

  return null
}

function run(cmake, args) {
  console.log(`${DIM}> ${cmake} ${args.join(' ')}${RESET}`)
  const result = spawnSync(cmake, args, { stdio: 'inherit' })
  if (result.error) fail(`не удалось запустить cmake: ${result.error.message}`)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.platform !== 'win32') {
  fail(
    'нативный helper собирается только на Windows.',
    'process-loopback-capture использует Windows Audio Session API (WASAPI) с\n' +
      'AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK и требует Windows 10 build 19041+.',
  )
}

if (!existsSync(path.join(SOURCE_DIR, 'CMakeLists.txt'))) {
  fail(`не найден CMakeLists.txt в ${SOURCE_DIR}`)
}

const cmake = resolveCmake()

if (!cmake) {
  fail(
    'cmake не найден.',
    `${YELLOW}Установи Visual Studio 2022 Build Tools с C++ и CMake:${RESET}

  winget install Microsoft.VisualStudio.2022.BuildTools --override ^
    "--quiet --add Microsoft.VisualStudio.Workload.VCTools ^
     --add Microsoft.VisualStudio.Component.VC.CMake.Project --includeRecommended"

Важно, чтобы были отмечены компоненты:
  - MSVC v143 - VS 2022 C++ x64/x86 build tools
  - C++ CMake tools for Windows
  - Windows 10 SDK 10.0.19041.0 или новее (нужен process loopback API)

${YELLOW}Если Build Tools уже установлены${RESET} — CMake из их состава не попадает
в системный PATH. Запусти сборку из меню Пуск ->
"x64 Native Tools Command Prompt for VS 2022":

  cd ${PROJECT_ROOT}
  pnpm run build:native

Перезагрузка компьютера при этом не требуется.`,
  )
}

console.log(`Использую cmake: ${cmake}`)

// -A x64: helper обязан быть 64-битным, это проверяет scripts/check-native-helper.mjs.
run(cmake, ['-S', SOURCE_DIR, '-B', BUILD_DIR, '-A', 'x64'])
run(cmake, ['--build', BUILD_DIR, '--config', 'Release'])

console.log(`\n${GREEN}Готово.${RESET} Проверь результат: ${DIM}pnpm run check:native${RESET}\n`)
