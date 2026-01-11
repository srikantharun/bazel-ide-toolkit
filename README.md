# Bazel IDE Toolkit

**Bridging the gap between Bazel and modern IDE workflows**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

---

## The Problem

Bazel offers powerful, hermetic builds but lags behind CMake in IDE integration. Developers face:

- **Manual compile_commands.json regeneration** after every BUILD change
- **No one-click build/run/debug** from IDE UI
- **Complex multi-platform toolchain switching**
- **Disconnected remote cache/execution status**
- **Limited Starlark editing support**

This toolkit aims to make Bazel feel as seamless as CMake in VS Code and CLion.

---

## Components

### 1. Auto-Refresh Daemon (`bazel-ide-daemon`)

File watcher that automatically regenerates `compile_commands.json` when BUILD files change.

```bash
# Install
pip install bazel-ide-toolkit

# Run daemon (watches for changes, auto-refreshes)
bazel-ide watch
```

**Features:**
- Watches BUILD, BUILD.bazel, *.bzl, WORKSPACE, MODULE.bazel
- Debounced refresh (waits for burst of changes to settle)
- Incremental updates (only affected targets)
- Platform-aware (switches compile commands per active platform)

### 2. VS Code Extension (`vscode-bazel-toolkit`)

Enhanced Bazel experience for VS Code.

**Features:**
- Auto-refresh compile_commands.json on save
- Platform/toolchain switcher in status bar
- Build/test/run buttons via CodeLens
- Remote cache hit/miss indicators
- Dependency graph visualization

### 3. Bazel Rules (`rules_ide`)

Bazel rules for IDE integration.

```python
load("@rules_ide//:defs.bzl", "ide_compile_commands")

ide_compile_commands(
    name = "compile_commands",
    targets = ["//src/..."],
    platforms = [
        "@platforms//os:linux",
        "@platforms//os:macos",
        "@platforms//os:windows",
    ],
    auto_refresh = True,
)
```

---

## Quick Start

### Option 1: CLI Daemon

```bash
# Install
pip install bazel-ide-toolkit

# Start watching (runs in background)
bazel-ide watch --targets="//src/..." --output=compile_commands.json

# Or one-shot refresh
bazel-ide refresh
```

### Option 2: VS Code Extension

1. Install "Bazel IDE Toolkit" from marketplace
2. Open a Bazel workspace
3. Extension auto-detects and starts watching

### Option 3: Bazel Rules (Bzlmod)

```python
# MODULE.bazel
bazel_dep(name = "rules_ide", version = "0.1.0")
```

```python
# BUILD.bazel
load("@rules_ide//:defs.bzl", "ide_compile_commands")

ide_compile_commands(
    name = "ide",
    targets = ["//..."],
)
```

```bash
# Manual refresh
bazel run //:ide

# Or enable file watching
bazel run //:ide -- --watch
```

---

## Roadmap

### Phase 1: Core Infrastructure (Current)
- [x] Project setup
- [ ] File watcher daemon
- [ ] Debounced compile_commands.json refresh
- [ ] CLI interface

### Phase 2: VS Code Extension
- [ ] Extension scaffolding
- [ ] Auto-refresh integration
- [ ] Platform switcher UI
- [ ] CodeLens for BUILD files

### Phase 3: Advanced Features
- [ ] Incremental compile_commands updates
- [ ] Remote cache status indicators
- [ ] Dependency graph visualization
- [ ] Build profiling integration

### Phase 4: CLion Plugin
- [ ] IntelliJ plugin scaffolding
- [ ] Bazel project sync improvements
- [ ] Toolchain switcher UI

---

## Pain Points Addressed

| Pain Point | Solution | Status |
|------------|----------|--------|
| Manual compile_commands.json refresh | Auto-refresh daemon | In Progress |
| No one-click build/run/debug | CodeLens + Run configs | Planned |
| Complex platform switching | Status bar switcher | Planned |
| No remote cache visibility | Cache hit/miss indicators | Planned |
| Poor Starlark editing | Enhanced language server | Planned |
| No dependency visualization | Interactive graph view | Planned |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      IDE (VS Code / CLion)                   │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Extension  │  │  CodeLens   │  │  Platform Switcher  │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
└─────────┼────────────────┼────────────────────┼─────────────┘
          │                │                    │
          ▼                ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    bazel-ide-daemon                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ File Watcher │  │  Bazel Query │  │ compile_commands │   │
│  │  (inotify)   │──│   Bridge     │──│    Generator     │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│                         Bazel                                │
│  ┌──────────┐  ┌───────────────┐  ┌─────────────────────┐   │
│  │  Query   │  │  Action Graph │  │  Remote Execution   │   │
│  └──────────┘  └───────────────┘  └─────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Priority Areas
1. **File watcher daemon** - Core functionality
2. **VS Code extension** - Most requested
3. **Documentation** - Setup guides for different workflows

---

## Related Projects

- [hedronvision/bazel-compile-commands-extractor](https://github.com/hedronvision/bazel-compile-commands-extractor) - Original compile_commands generator
- [bazelbuild/vscode-bazel](https://github.com/bazelbuild/vscode-bazel) - Official VS Code extension
- [bazelbuild/intellij](https://github.com/bazelbuild/intellij) - Official IntelliJ/CLion plugin

---

## License

Apache 2.0 - See [LICENSE](LICENSE)
