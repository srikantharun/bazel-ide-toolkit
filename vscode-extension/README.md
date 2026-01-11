# Bazel IDE Toolkit

Enhanced Bazel integration for VS Code with automatic `compile_commands.json` generation.

## Features

- **Auto-refresh compile_commands.json** - Automatically regenerates when BUILD files change
- **Status bar integration** - Shows refresh status and click to manually refresh
- **Platform selection** - Switch target platforms for cross-compilation
- **Debounced updates** - Configurable delay to batch rapid changes

## Requirements

- [Bazel](https://bazel.build/) installed and in PATH
- [hedron_compile_commands](https://github.com/hedronvision/bazel-compile-commands-extractor) configured in your workspace
- [clangd extension](https://marketplace.visualstudio.com/items?itemName=llvm-vs-code-extensions.vscode-clangd) for C++ intellisense

## Setup

1. Add hedron_compile_commands to your `MODULE.bazel`:

```starlark
bazel_dep(name = "hedron_compile_commands", dev_dependency = True)
git_override(
    module_name = "hedron_compile_commands",
    remote = "https://github.com/hedronvision/bazel-compile-commands-extractor.git",
    commit = "4f28899228fb3ad0126897876f147ca15026151e",
)
```

2. Add refresh target to your root `BUILD.bazel`:

```starlark
load("@hedron_compile_commands//:refresh_compile_commands.bzl", "refresh_compile_commands")

refresh_compile_commands(
    name = "refresh_compile_commands",
    targets = {"//...": ""},
)
```

3. Install this extension and the clangd extension
4. Open your Bazel workspace - the extension activates automatically

## Commands

- `Bazel: Refresh compile_commands.json` - Manually trigger refresh
- `Bazel: Toggle Auto-Refresh` - Enable/disable automatic refresh on file changes
- `Bazel: Select Platform` - Choose target platform for cross-compilation

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `bazelIdeToolkit.autoRefresh` | `true` | Auto-refresh on BUILD file changes |
| `bazelIdeToolkit.debounceMs` | `2000` | Delay before refresh (ms) |
| `bazelIdeToolkit.targets` | `//...` | Bazel targets to include |
| `bazelIdeToolkit.showStatusBar` | `true` | Show status bar item |

## How It Works

1. Extension watches for changes to BUILD, BUILD.bazel, *.bzl, WORKSPACE, MODULE.bazel
2. On change, waits for debounce period (default 2s)
3. Runs `bazel run @hedron_compile_commands//:refresh_all` or `//:refresh_compile_commands`
4. clangd picks up the new `compile_commands.json` automatically

## License

Apache-2.0
