# Bazel IDE Toolkit

**Bridging the gap between Bazel and modern IDE workflows**

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/srikantharun.bazel-ide-toolkit?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=srikantharun.bazel-ide-toolkit)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

---

## The Problem

Bazel offers powerful, hermetic builds but lags behind CMake in IDE integration. Developers face:

- **Manual compile_commands.json regeneration** after every BUILD change
- **No one-click build/run/debug** from IDE UI
- **Complex multi-platform toolchain switching**
- **Poor Starlark/BUILD file editing support**
- **No dependency visualization**

This toolkit makes Bazel feel as seamless as CMake in VS Code (and eventually CLion).

---

## Installation

### VS Code Extension

```bash
# From command line
code --install-extension srikantharun.bazel-ide-toolkit

# Or search "Bazel IDE Toolkit" in VS Code Extensions
```

**Also install clangd for C++ IntelliSense:**
```bash
code --install-extension llvm-vs-code-extensions.vscode-clangd
```

### Python CLI (Optional)

```bash
pip install bazel-ide-toolkit
bazel-ide watch  # Start file watcher daemon
```

---

## Setup

### Step 1: Add hedron_compile_commands to MODULE.bazel

```starlark
bazel_dep(name = "hedron_compile_commands", dev_dependency = True)
git_override(
    module_name = "hedron_compile_commands",
    remote = "https://github.com/hedronvision/bazel-compile-commands-extractor.git",
    commit = "4f28899228fb3ad0126897876f147ca15026151e",
)
```

### Step 2: Add refresh target to BUILD.bazel

```starlark
load("@hedron_compile_commands//:refresh_compile_commands.bzl", "refresh_compile_commands")

refresh_compile_commands(
    name = "refresh_compile_commands",
    targets = {"//...": ""},
)
```

**For large monorepos**, specify targeted packages:

```starlark
refresh_compile_commands(
    name = "refresh_compile_commands",
    exclude_external_sources = True,
    targets = {
        "//src/...": "",
        "//lib/...": "",
        "//tools/...": "",
    },
)
```

### Step 3: Generate Initial compile_commands.json

```bash
bazel run //:refresh_compile_commands
```

### Step 4: Open in VS Code

The extension activates automatically and keeps `compile_commands.json` in sync.

---

## Features

### v0.1.0 (Current)

| Feature | Description |
|---------|-------------|
| **Auto-refresh compile_commands.json** | Watches BUILD, *.bzl, WORKSPACE, MODULE.bazel |
| **Debounced updates** | Configurable delay to batch rapid changes |
| **Status bar integration** | Shows refresh status, click to manual refresh |
| **Targeted refresh** | Specify packages to reduce refresh time |
| **exclude_external_sources** | Skip external deps for faster generation |
| **Platform selection** | Switch target platform (seed for v0.2) |

### v0.2.0 (In Development)

| Feature | Description |
|---------|-------------|
| **Build/Run/Test commands** | Sidebar commands + keyboard shortcuts |
| **CodeLens for BUILD files** | Clickable "Build" / "Test" / "Run" above targets |
| **Test gutter icons** | Green triangles for cc_test in source files |
| **Multi-platform auto-refresh** | Switch platform → auto-regenerate compile_commands |

---

## Commands

Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Linux/Windows):

| Command | Description |
|---------|-------------|
| `Bazel: Refresh compile_commands.json` | Manual refresh |
| `Bazel: Toggle Auto-Refresh` | Enable/disable file watching |
| `Bazel: Select Platform` | Switch target platform |
| `Bazel: Build Target` | Build current file's target *(v0.2)* |
| `Bazel: Test Target` | Run tests for current file *(v0.2)* |
| `Bazel: Run Target` | Run binary target *(v0.2)* |

---

## Settings

```json
{
  "bazelIdeToolkit.autoRefresh": true,
  "bazelIdeToolkit.debounceMs": 2000,
  "bazelIdeToolkit.targets": "//...",
  "bazelIdeToolkit.showStatusBar": true
}
```

---

## Roadmap

### Phase 1: Core IntelliSense ✅ Complete

- [x] Auto-refresh compile_commands.json on BUILD file changes
- [x] File watching with debounce
- [x] Status bar integration
- [x] Targeted refresh + exclude_external_sources
- [x] Platform selection command (seed)
- [x] VS Code extension published to marketplace
- [x] Python CLI daemon

### Phase 2: Build/Run/Test Integration 🚧 In Progress

- [ ] Build/Run/Test commands in command palette
- [ ] CodeLens for BUILD files (clickable Build/Test/Run)
- [ ] Test gutter icons in source files
- [ ] Keyboard shortcuts (Cmd+B to build, Cmd+T to test)
- [ ] Build output panel integration
- [ ] Multi-platform auto-refresh on platform switch

### Phase 3: Starlark Editing

- [ ] Enhanced syntax highlighting
- [ ] Autocomplete for rules/attributes (cc_library, deps, select())
- [ ] Buildifier format on save
- [ ] Quick-fixes for common issues
- [ ] Go-to-definition for load() statements

### Phase 4: Advanced Features

- [ ] Dependency graph visualization
- [ ] "Find what depends on me" command
- [ ] Remote cache hit/miss indicators
- [ ] Build profiling integration
- [ ] Migration helpers (CMake → Bazel suggestions)

### Phase 5: CLion Support

- [ ] Documentation for CLion + Bazel plugin
- [ ] Companion daemon for auto-refresh
- [ ] IntelliJ plugin (if demand warrants)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    VS Code / CLion                          │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Extension  │  │  CodeLens   │  │  Platform Switcher  │  │
│  │  (TS/JS)    │  │  (BUILD)    │  │  (Status Bar)       │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
└─────────┼────────────────┼────────────────────┼─────────────┘
          │                │                    │
          ▼                ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                      File Watcher                           │
│  BUILD, BUILD.bazel, *.bzl, WORKSPACE, MODULE.bazel         │
└─────────────────────────────────────────────────────────────┘
          │
          ▼ (debounced)
┌─────────────────────────────────────────────────────────────┐
│            hedron_compile_commands                          │
│  bazel run @hedron_compile_commands//:refresh_all           │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│                  compile_commands.json                      │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│                        clangd                               │
│  IntelliSense, Go-to-Definition, Autocomplete, Errors       │
└─────────────────────────────────────────────────────────────┘
```

---

## Pain Points Addressed

| Pain Point | Solution | Status |
|------------|----------|--------|
| Manual compile_commands.json refresh | Auto-refresh on file change | ✅ Done |
| No one-click build/run/debug | CodeLens + Commands | 🚧 v0.2 |
| Complex platform switching | Status bar switcher + auto-refresh | 🚧 v0.2 |
| Poor Starlark editing | Autocomplete + Buildifier | 📋 Planned |
| No dependency visualization | Interactive graph view | 📋 Planned |
| CLion support | Companion daemon + docs | 📋 Planned |

---

## Contributing

Contributions welcome! Priority areas:

1. **Build/Run/Test integration** - CodeLens, commands, keybindings
2. **Multi-platform workflow** - Auto-refresh on platform switch
3. **Starlark editing** - Autocomplete, Buildifier integration
4. **Documentation** - Setup guides for different workflows

---

## Related Projects

- [hedronvision/bazel-compile-commands-extractor](https://github.com/hedronvision/bazel-compile-commands-extractor) - compile_commands generator (we build on this)
- [bazelbuild/vscode-bazel](https://github.com/bazelbuild/vscode-bazel) - Official VS Code extension (syntax highlighting)
- [bazelbuild/intellij](https://github.com/bazelbuild/intellij) - Official IntelliJ/CLion plugin

---

## License

Apache 2.0 - See [LICENSE](LICENSE)
