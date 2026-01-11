import * as vscode from 'vscode';
import * as cp from 'child_process';

let statusBarItem: vscode.StatusBarItem;
let fileWatcher: vscode.FileSystemWatcher | undefined;
let refreshTimeout: NodeJS.Timeout | undefined;
let isRefreshing = false;

// Patterns to watch for changes
const WATCH_PATTERNS = [
    '**/BUILD',
    '**/BUILD.bazel',
    '**/*.bzl',
    '**/WORKSPACE',
    '**/WORKSPACE.bazel',
    '**/MODULE.bazel',
];

export function activate(context: vscode.ExtensionContext) {
    console.log('Bazel IDE Toolkit activating...');

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'bazel-ide-toolkit.refresh';
    updateStatusBar('$(sync) Bazel', 'Click to refresh compile_commands.json');
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('bazel-ide-toolkit.refresh', refreshCompileCommands),
        vscode.commands.registerCommand('bazel-ide-toolkit.toggleAutoRefresh', toggleAutoRefresh),
        vscode.commands.registerCommand('bazel-ide-toolkit.selectPlatform', selectPlatform),
    );

    // Set up file watchers if auto-refresh is enabled
    const config = vscode.workspace.getConfiguration('bazelIdeToolkit');
    if (config.get<boolean>('autoRefresh')) {
        setupFileWatchers(context);
    }

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('bazelIdeToolkit.autoRefresh')) {
                const autoRefresh = vscode.workspace.getConfiguration('bazelIdeToolkit').get<boolean>('autoRefresh');
                if (autoRefresh) {
                    setupFileWatchers(context);
                } else {
                    disposeFileWatchers();
                }
            }
        })
    );

    console.log('Bazel IDE Toolkit activated');
}

function setupFileWatchers(context: vscode.ExtensionContext) {
    disposeFileWatchers();

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return;
    }

    // Create a composite file watcher
    for (const pattern of WATCH_PATTERNS) {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceRoot, pattern)
        );

        watcher.onDidChange(() => triggerDebouncedRefresh());
        watcher.onDidCreate(() => triggerDebouncedRefresh());
        watcher.onDidDelete(() => triggerDebouncedRefresh());

        context.subscriptions.push(watcher);
    }

    console.log('File watchers set up for BUILD file changes');
}

function disposeFileWatchers() {
    if (fileWatcher) {
        fileWatcher.dispose();
        fileWatcher = undefined;
    }
}

function triggerDebouncedRefresh() {
    if (refreshTimeout) {
        clearTimeout(refreshTimeout);
    }

    const config = vscode.workspace.getConfiguration('bazelIdeToolkit');
    const debounceMs = config.get<number>('debounceMs') || 2000;

    updateStatusBar('$(sync~spin) Bazel', 'Change detected, waiting...');

    refreshTimeout = setTimeout(() => {
        refreshCompileCommands();
    }, debounceMs);
}

async function refreshCompileCommands() {
    if (isRefreshing) {
        vscode.window.showInformationMessage('Refresh already in progress...');
        return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('Not in a Bazel workspace');
        return;
    }

    isRefreshing = true;
    updateStatusBar('$(sync~spin) Bazel', 'Refreshing compile_commands.json...');

    try {
        // Try hedron extractor first
        let command = 'bazel run @hedron_compile_commands//:refresh_all';

        // Check if hedron is available
        const checkResult = await runCommand(
            'bazel query @hedron_compile_commands//:refresh_all',
            workspaceRoot
        );

        if (checkResult.exitCode !== 0) {
            // Fall back to local target
            const localCheck = await runCommand(
                'bazel query //:refresh_compile_commands',
                workspaceRoot
            );
            if (localCheck.exitCode === 0) {
                command = 'bazel run //:refresh_compile_commands';
            } else {
                throw new Error('No compile_commands generator found. Add hedron_compile_commands to MODULE.bazel');
            }
        }

        const startTime = Date.now();
        const result = await runCommand(command, workspaceRoot);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (result.exitCode === 0) {
            updateStatusBar('$(check) Bazel', `Refreshed in ${elapsed}s`);
            vscode.window.setStatusBarMessage(`compile_commands.json refreshed in ${elapsed}s`, 3000);
        } else {
            updateStatusBar('$(error) Bazel', 'Refresh failed');
            vscode.window.showErrorMessage(`Refresh failed: ${result.stderr.slice(-200)}`);
        }
    } catch (error: any) {
        updateStatusBar('$(error) Bazel', 'Refresh failed');
        vscode.window.showErrorMessage(`Refresh error: ${error.message}`);
    } finally {
        isRefreshing = false;
    }
}

async function toggleAutoRefresh() {
    const config = vscode.workspace.getConfiguration('bazelIdeToolkit');
    const current = config.get<boolean>('autoRefresh');
    await config.update('autoRefresh', !current, vscode.ConfigurationTarget.Workspace);

    const status = !current ? 'enabled' : 'disabled';
    vscode.window.showInformationMessage(`Auto-refresh ${status}`);
}

async function selectPlatform() {
    const platforms = [
        { label: '$(device-desktop) Linux x86_64', value: '@platforms//os:linux' },
        { label: '$(device-desktop) macOS ARM64', value: '@platforms//os:macos' },
        { label: '$(device-desktop) Windows x86_64', value: '@platforms//os:windows' },
        { label: '$(device-mobile) Android ARM64', value: '@platforms//os:android' },
        { label: '$(device-mobile) iOS ARM64', value: '@platforms//os:ios' },
    ];

    const selected = await vscode.window.showQuickPick(platforms, {
        placeHolder: 'Select target platform for compile_commands.json',
    });

    if (selected) {
        vscode.window.showInformationMessage(`Selected platform: ${selected.label}`);
        // TODO: Regenerate compile_commands.json with platform flag
    }
}

function getWorkspaceRoot(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
    }
    return workspaceFolders[0].uri.fsPath;
}

function updateStatusBar(text: string, tooltip: string) {
    statusBarItem.text = text;
    statusBarItem.tooltip = tooltip;
}

interface CommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

function runCommand(command: string, cwd: string): Promise<CommandResult> {
    return new Promise((resolve) => {
        cp.exec(command, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({
                exitCode: error?.code || 0,
                stdout: stdout || '',
                stderr: stderr || '',
            });
        });
    });
}

export function deactivate() {
    disposeFileWatchers();
}
