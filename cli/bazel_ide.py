#!/usr/bin/env python3
"""
Bazel IDE Toolkit - CLI daemon for automatic compile_commands.json generation.

Usage:
    bazel-ide watch [--targets=TARGETS] [--output=FILE] [--debounce=MS]
    bazel-ide refresh [--targets=TARGETS] [--output=FILE]
    bazel-ide status
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional, Set
import threading
import hashlib

try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler, FileSystemEvent
    WATCHDOG_AVAILABLE = True
except ImportError:
    WATCHDOG_AVAILABLE = False
    print("Warning: watchdog not installed. File watching disabled.", file=sys.stderr)
    print("Install with: pip install watchdog", file=sys.stderr)


# File patterns to watch
WATCH_PATTERNS = {
    "BUILD",
    "BUILD.bazel",
    "WORKSPACE",
    "WORKSPACE.bazel",
    "MODULE.bazel",
    "MODULE.bazel.lock",
}
WATCH_EXTENSIONS = {".bzl", ".bazel"}


def find_workspace_root() -> Optional[Path]:
    """Find the Bazel workspace root by looking for WORKSPACE or MODULE.bazel."""
    current = Path.cwd()
    while current != current.parent:
        if (current / "WORKSPACE").exists() or (current / "WORKSPACE.bazel").exists():
            return current
        if (current / "MODULE.bazel").exists():
            return current
        current = current.parent
    return None


def is_bazel_file(path: str) -> bool:
    """Check if a file is a Bazel-related file that should trigger refresh."""
    name = os.path.basename(path)
    if name in WATCH_PATTERNS:
        return True
    _, ext = os.path.splitext(name)
    return ext in WATCH_EXTENSIONS


class RefreshManager:
    """Manages debounced refresh of compile_commands.json."""

    def __init__(
        self,
        workspace_root: Path,
        targets: str = "//...",
        output_file: str = "compile_commands.json",
        debounce_ms: int = 2000,
    ):
        self.workspace_root = workspace_root
        self.targets = targets
        self.output_file = output_file
        self.debounce_ms = debounce_ms

        self._pending_refresh = False
        self._last_trigger_time = 0.0
        self._refresh_lock = threading.Lock()
        self._refresh_thread: Optional[threading.Thread] = None
        self._last_content_hash: Optional[str] = None

    def trigger_refresh(self):
        """Trigger a debounced refresh."""
        with self._refresh_lock:
            self._pending_refresh = True
            self._last_trigger_time = time.time()

            # Start debounce thread if not running
            if self._refresh_thread is None or not self._refresh_thread.is_alive():
                self._refresh_thread = threading.Thread(target=self._debounce_loop, daemon=True)
                self._refresh_thread.start()

    def _debounce_loop(self):
        """Wait for debounce period, then refresh if no new triggers."""
        while True:
            time.sleep(self.debounce_ms / 1000.0)

            with self._refresh_lock:
                elapsed = (time.time() - self._last_trigger_time) * 1000
                if elapsed >= self.debounce_ms and self._pending_refresh:
                    self._pending_refresh = False
                    break
                elif not self._pending_refresh:
                    return

        # Perform refresh
        self._do_refresh()

    def _do_refresh(self):
        """Actually run the refresh command."""
        print(f"\n[bazel-ide] Refreshing compile_commands.json for {self.targets}...")
        start_time = time.time()

        try:
            # Check if hedron extractor is available
            result = subprocess.run(
                ["bazel", "query", "@hedron_compile_commands//:refresh_all"],
                cwd=self.workspace_root,
                capture_output=True,
                text=True,
            )

            if result.returncode == 0:
                # Use hedron extractor
                cmd = ["bazel", "run", "@hedron_compile_commands//:refresh_all"]
            else:
                # Fall back to local refresh_compile_commands if defined
                result = subprocess.run(
                    ["bazel", "query", "//:refresh_compile_commands"],
                    cwd=self.workspace_root,
                    capture_output=True,
                    text=True,
                )
                if result.returncode == 0:
                    cmd = ["bazel", "run", "//:refresh_compile_commands"]
                else:
                    print("[bazel-ide] No compile_commands generator found.", file=sys.stderr)
                    print("[bazel-ide] Add hedron_compile_commands to your MODULE.bazel", file=sys.stderr)
                    return

            # Run the refresh
            result = subprocess.run(
                cmd,
                cwd=self.workspace_root,
                capture_output=True,
                text=True,
            )

            elapsed = time.time() - start_time

            if result.returncode == 0:
                # Check if content actually changed
                output_path = self.workspace_root / self.output_file
                if output_path.exists():
                    with open(output_path, "rb") as f:
                        content_hash = hashlib.md5(f.read()).hexdigest()

                    if content_hash != self._last_content_hash:
                        self._last_content_hash = content_hash
                        print(f"[bazel-ide] Refreshed in {elapsed:.1f}s (content changed)")
                    else:
                        print(f"[bazel-ide] Refreshed in {elapsed:.1f}s (no changes)")
                else:
                    print(f"[bazel-ide] Refreshed in {elapsed:.1f}s")
            else:
                print(f"[bazel-ide] Refresh failed ({elapsed:.1f}s):", file=sys.stderr)
                if result.stderr:
                    # Print last few lines of error
                    lines = result.stderr.strip().split('\n')
                    for line in lines[-5:]:
                        print(f"  {line}", file=sys.stderr)

        except Exception as e:
            print(f"[bazel-ide] Error: {e}", file=sys.stderr)

    def refresh_now(self):
        """Perform an immediate refresh (no debounce)."""
        self._do_refresh()


class BazelFileHandler(FileSystemEventHandler):
    """Handles file system events for Bazel files."""

    def __init__(self, refresh_manager: RefreshManager):
        self.refresh_manager = refresh_manager
        self._seen_events: Set[str] = set()

    def on_any_event(self, event: FileSystemEvent):
        if event.is_directory:
            return

        path = event.src_path
        if not is_bazel_file(path):
            return

        # Deduplicate rapid events for same file
        event_key = f"{event.event_type}:{path}"
        if event_key in self._seen_events:
            return
        self._seen_events.add(event_key)

        # Clear seen events periodically
        if len(self._seen_events) > 1000:
            self._seen_events.clear()

        print(f"[bazel-ide] Detected change: {os.path.basename(path)}")
        self.refresh_manager.trigger_refresh()


def cmd_watch(args):
    """Watch for BUILD file changes and auto-refresh."""
    if not WATCHDOG_AVAILABLE:
        print("Error: watchdog package required for watch mode", file=sys.stderr)
        print("Install with: pip install watchdog", file=sys.stderr)
        sys.exit(1)

    workspace_root = find_workspace_root()
    if not workspace_root:
        print("Error: Not in a Bazel workspace", file=sys.stderr)
        sys.exit(1)

    print(f"[bazel-ide] Workspace: {workspace_root}")
    print(f"[bazel-ide] Targets: {args.targets}")
    print(f"[bazel-ide] Output: {args.output}")
    print(f"[bazel-ide] Debounce: {args.debounce}ms")
    print(f"[bazel-ide] Watching for BUILD file changes... (Ctrl+C to stop)")

    refresh_manager = RefreshManager(
        workspace_root=workspace_root,
        targets=args.targets,
        output_file=args.output,
        debounce_ms=args.debounce,
    )

    # Initial refresh
    if args.initial_refresh:
        refresh_manager.refresh_now()

    # Start watching
    event_handler = BazelFileHandler(refresh_manager)
    observer = Observer()
    observer.schedule(event_handler, str(workspace_root), recursive=True)
    observer.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[bazel-ide] Stopping...")
        observer.stop()
    observer.join()


def cmd_refresh(args):
    """One-shot refresh of compile_commands.json."""
    workspace_root = find_workspace_root()
    if not workspace_root:
        print("Error: Not in a Bazel workspace", file=sys.stderr)
        sys.exit(1)

    refresh_manager = RefreshManager(
        workspace_root=workspace_root,
        targets=args.targets,
        output_file=args.output,
    )
    refresh_manager.refresh_now()


def cmd_status(args):
    """Show status of Bazel IDE integration."""
    workspace_root = find_workspace_root()
    if not workspace_root:
        print("Error: Not in a Bazel workspace", file=sys.stderr)
        sys.exit(1)

    print(f"Workspace: {workspace_root}")

    # Check compile_commands.json
    cc_path = workspace_root / "compile_commands.json"
    if cc_path.exists():
        stat = cc_path.stat()
        mtime = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime))
        size = stat.st_size / 1024

        # Count entries
        try:
            with open(cc_path) as f:
                entries = len(json.load(f))
            print(f"compile_commands.json: {entries} entries, {size:.1f}KB, updated {mtime}")
        except:
            print(f"compile_commands.json: {size:.1f}KB, updated {mtime}")
    else:
        print("compile_commands.json: Not found")

    # Check for hedron extractor
    result = subprocess.run(
        ["bazel", "query", "@hedron_compile_commands//:refresh_all"],
        cwd=workspace_root,
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        print("hedron_compile_commands: Installed")
    else:
        print("hedron_compile_commands: Not found")

    # Check for local refresh target
    result = subprocess.run(
        ["bazel", "query", "//:refresh_compile_commands"],
        cwd=workspace_root,
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        print("Local refresh target: Available (//:refresh_compile_commands)")


def main():
    parser = argparse.ArgumentParser(
        description="Bazel IDE Toolkit - Automatic compile_commands.json generation"
    )
    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # Watch command
    watch_parser = subparsers.add_parser("watch", help="Watch for changes and auto-refresh")
    watch_parser.add_argument(
        "--targets", "-t",
        default="//...",
        help="Bazel targets to include (default: //...)"
    )
    watch_parser.add_argument(
        "--output", "-o",
        default="compile_commands.json",
        help="Output file (default: compile_commands.json)"
    )
    watch_parser.add_argument(
        "--debounce", "-d",
        type=int,
        default=2000,
        help="Debounce delay in milliseconds (default: 2000)"
    )
    watch_parser.add_argument(
        "--no-initial-refresh",
        dest="initial_refresh",
        action="store_false",
        help="Skip initial refresh on startup"
    )
    watch_parser.set_defaults(func=cmd_watch, initial_refresh=True)

    # Refresh command
    refresh_parser = subparsers.add_parser("refresh", help="One-shot refresh")
    refresh_parser.add_argument(
        "--targets", "-t",
        default="//...",
        help="Bazel targets to include (default: //...)"
    )
    refresh_parser.add_argument(
        "--output", "-o",
        default="compile_commands.json",
        help="Output file (default: compile_commands.json)"
    )
    refresh_parser.set_defaults(func=cmd_refresh)

    # Status command
    status_parser = subparsers.add_parser("status", help="Show IDE integration status")
    status_parser.set_defaults(func=cmd_status)

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == "__main__":
    main()
