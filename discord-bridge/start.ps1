$ErrorActionPreference = "Stop"

$node = "C:\Users\Bruker\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (!(Test-Path $node)) {
  throw "Could not find bundled Node.js at $node"
}

& $node ".\index.js"
