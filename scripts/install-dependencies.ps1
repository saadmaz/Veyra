<#
  One-time dependency bootstrap for the VEYRA monorepo.

  The package.json files were scaffolded without versions so that each dependency resolves to
  the current release when first installed. Run this ONCE on a link-capable drive (NTFS, not
  exFAT/FAT32), then commit the updated package.json files and bun.lock. After that, everyone
  just runs `bun install`.

  Usage (from the repo root):  powershell -ExecutionPolicy Bypass -File scripts\install-dependencies.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function Add-Deps {
    param([string]$Dir, [string[]]$Deps, [switch]$Dev)
    if (-not $Deps -or $Deps.Count -eq 0) { return }
    Push-Location (Join-Path $root $Dir)
    try {
        Write-Host "`n[$Dir] bun add $(if ($Dev) { '-d ' })$($Deps -join ' ')" -ForegroundColor Cyan
        if ($Dev) { bun add -d @Deps } else { bun add @Deps }
        if ($LASTEXITCODE -ne 0) { throw "bun add failed in $Dir" }
    } finally { Pop-Location }
}

# Root tooling
Add-Deps '.' -Dev @('turbo', 'typescript', '@biomejs/biome', 'vitest', '@types/node')

# Packages
Add-Deps 'packages/db' @('@prisma/client', '@prisma/adapter-pg', '@veyra/domain@workspace:*')
Add-Deps 'packages/db' -Dev @('prisma')

# API
Add-Deps 'apps/api' @(
    '@nestjs/common', '@nestjs/core', '@nestjs/platform-express', '@nestjs/swagger',
    'reflect-metadata', 'rxjs', 'helmet', 'zod', 'ioredis', 'express',
    '@veyra/domain@workspace:*', '@veyra/db@workspace:*', '@veyra/api-contracts@workspace:*'
)
Add-Deps 'apps/api' -Dev @('@nestjs/testing', 'supertest', '@types/supertest', '@types/express', 'unplugin-swc', '@swc/core')

# Worker
Add-Deps 'apps/worker' @('bullmq', 'ioredis', 'zod', '@veyra/domain@workspace:*')

# Web apps
$webDev = @('@types/react', '@types/react-dom')
Add-Deps 'apps/console-web' @('next', 'react', 'react-dom',
    '@veyra/domain@workspace:*', '@veyra/design-tokens@workspace:*',
    '@veyra/api-contracts@workspace:*', '@veyra/web-config@workspace:*')
Add-Deps 'apps/console-web' -Dev $webDev
Add-Deps 'apps/marketing-web' @('next', 'react', 'react-dom',
    '@veyra/design-tokens@workspace:*', '@veyra/web-config@workspace:*')
Add-Deps 'apps/marketing-web' -Dev $webDev
Add-Deps 'apps/admin-web' @('next', 'react', 'react-dom',
    '@veyra/design-tokens@workspace:*', '@veyra/api-contracts@workspace:*', '@veyra/web-config@workspace:*')
Add-Deps 'apps/admin-web' -Dev $webDev

# Mobile: add Expo first, then let `expo install` pick versions compatible with that Expo SDK.
Add-Deps 'apps/resident-mobile' @('expo', '@veyra/design-tokens@workspace:*', '@veyra/api-contracts@workspace:*')
Push-Location (Join-Path $root 'apps/resident-mobile')
try {
    bunx expo install expo-router expo-status-bar expo-linking expo-constants expo-secure-store `
        react react-native react-native-safe-area-context react-native-screens
    if ($LASTEXITCODE -ne 0) { throw 'expo install failed' }
    bunx expo install --dev @types/react
} finally { Pop-Location }

Write-Host "`nDone. Next: bun run lint; bun run typecheck; bun run test; bun run build" -ForegroundColor Green
Write-Host "Then commit the package.json files and bun.lock." -ForegroundColor Green
