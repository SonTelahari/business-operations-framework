$ErrorActionPreference = "Stop"

$pnpm = "C:\Users\Bruker\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\pnpm.cmd"

if (!(Test-Path $pnpm)) {
  throw "Could not find bundled pnpm at $pnpm"
}

& $pnpm install
