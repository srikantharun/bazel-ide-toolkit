import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
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

    // Create output channel for build output
    outputChannel = vscode.window.createOutputChannel('Bazel');
    context.subscriptions.push(outputChannel);

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
        vscode.commands.registerCommand('bazel-ide-toolkit.buildTarget', buildTarget),
        vscode.commands.registerCommand('bazel-ide-toolkit.testTarget', testTarget),
        vscode.commands.registerCommand('bazel-ide-toolkit.runTarget', runTarget),
        vscode.commands.registerCommand('bazel-ide-toolkit.buildFile', buildCurrentFile),
        vscode.commands.registerCommand('bazel-ide-toolkit.testFile', testCurrentFile),
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
                }
            }
        })
    );

    console.log('Bazel IDE Toolkit activated');
}

function setupFileWatchers(context: vscode.ExtensionContext) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return;
    }

    // Create file watchers for each pattern
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
        { label: '$(device-desktop) Linux x86_64', value: 'linux-x86_64', flag: '--platforms=@platforms//os:linux' },
        { label: '$(device-desktop) macOS ARM64', value: 'macos-arm64', flag: '--platforms=@platforms//os:macos' },
        { label: '$(device-desktop) Windows x86_64', value: 'windows-x86_64', flag: '--platforms=@platforms//os:windows' },
        { label: '$(device-mobile) Android ARM64', value: 'android-arm64', flag: '--platforms=@platforms//os:android' },
        { label: '$(device-mobile) iOS ARM64', value: 'ios-arm64', flag: '--platforms=@platforms//os:ios' },
    ];

    const selected = await vscode.window.showQuickPick(platforms, {
        placeHolder: 'Select target platform for compile_commands.json',
    });

    if (selected) {
        vscode.window.showInformationMessage(`Selected platform: ${selected.label}`);
        // Trigger refresh with new platform
        refreshCompileCommands();
    }
}

// ============ Build/Run/Test Commands ============

async function buildTarget() {
    const target = await promptForTarget('build');
    if (target) {
        await executeBazelCommand('build', target);
    }
}

async function testTarget() {
    const target = await promptForTarget('test');
    if (target) {
        await executeBazelCommand('test', target);
    }
}

async function runTarget() {
    const target = await promptForTarget('run');
    if (target) {
        await executeBazelCommand('run', target);
    }
}

async function buildCurrentFile() {
    const target = await findTargetForCurrentFile();
    if (target) {
        await executeBazelCommand('build', target);
    } else {
        vscode.window.showWarningMessage('Could not find Bazel target for current file');
    }
}

async function testCurrentFile() {
    const target = await findTargetForCurrentFile();
    if (target) {
        // Try to find associated test target
        const testTarget = target.replace(/:([^:]+)$/, ':$1_test');
        await executeBazelCommand('test', testTarget);
    } else {
        vscode.window.showWarningMessage('Could not find Bazel target for current file');
    }
}

async function promptForTarget(action: string): Promise<string | undefined> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('Not in a Bazel workspace');
        return undefined;
    }

    // Get recent targets from history or query
    const recentTargets = await getRecentTargets(workspaceRoot, action);

    const items: vscode.QuickPickItem[] = recentTargets.map(t => ({
        label: t,
        description: action
    }));

    // Add option to enter custom target
    items.push({
        label: '$(edit) Enter target manually...',
        description: 'Type a Bazel target label'
    });

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Select target to ${action}`,
        matchOnDescription: true
    });

    if (!selected) {
        return undefined;
    }

    if (selected.label.includes('Enter target manually')) {
        return await vscode.window.showInputBox({
            prompt: 'Enter Bazel target (e.g., //src:main)',
            placeHolder: '//...'
        });
    }

    return selected.label;
}

async function getRecentTargets(workspaceRoot: string, action: string): Promise<string[]> {
    // Query for targets based on action type
    let query = '';
    switch (action) {
        case 'test':
            query = 'kind(".*_test", //...)';
            break;
        case 'run':
            query = 'kind(".*_binary", //...)';
            break;
        default:
            query = 'kind("rule", //...)';
    }

    try {
        const result = await runCommand(
            `bazel query "${query}" --output=label 2>/dev/null | head -20`,
            workspaceRoot
        );
        if (result.exitCode === 0 && result.stdout.trim()) {
            return result.stdout.trim().split('\n').filter(t => t.startsWith('//'));
        }
    } catch {
        // Ignore errors, return empty list
    }

    return ['//...'];
}

async function findTargetForCurrentFile(): Promise<string | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return undefined;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return undefined;
    }

    const filePath = editor.document.uri.fsPath;
    const relativePath = path.relative(workspaceRoot, filePath);

    // Use bazel query to find target that owns this file
    try {
        const result = await runCommand(
            `bazel query "kind(rule, rdeps(//..., ${relativePath}, 1))" --output=label 2>/dev/null | head -1`,
            workspaceRoot
        );
        if (result.exitCode === 0 && result.stdout.trim()) {
            return result.stdout.trim();
        }
    } catch {
        // Fall back to guessing from path
    }

    // Fallback: construct target from file path
    const dir = path.dirname(relativePath);
    const basename = path.basename(relativePath, path.extname(relativePath));
    return `//${dir}:${basename}`;
}

async function executeBazelCommand(action: string, target: string) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('Not in a Bazel workspace');
        return;
    }

    const config = vscode.workspace.getConfiguration('bazelIdeToolkit');
    let flags: string[] = [];

    switch (action) {
        case 'build':
            flags = config.get<string[]>('buildFlags') || [];
            break;
        case 'test':
            flags = config.get<string[]>('testFlags') || [];
            break;
        case 'run':
            flags = config.get<string[]>('runFlags') || [];
            break;
    }

    const command = `bazel ${action} ${flags.join(' ')} ${target}`;

    outputChannel.clear();
    outputChannel.show(true);
    outputChannel.appendLine(`$ ${command}`);
    outputChannel.appendLine('');

    updateStatusBar(`$(sync~spin) Bazel`, `${action}ing ${target}...`);

    const startTime = Date.now();

    try {
        const result = await runCommandStreaming(command, workspaceRoot, (data) => {
            outputChannel.append(data);
        });

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (result.exitCode === 0) {
            updateStatusBar('$(check) Bazel', `${action} succeeded (${elapsed}s)`);
            outputChannel.appendLine('');
            outputChannel.appendLine(`✓ ${action} succeeded in ${elapsed}s`);
        } else {
            updateStatusBar('$(error) Bazel', `${action} failed`);
            outputChannel.appendLine('');
            outputChannel.appendLine(`✗ ${action} failed (exit code ${result.exitCode})`);
            vscode.window.showErrorMessage(`Bazel ${action} failed. See output for details.`);
        }
    } catch (error: any) {
        updateStatusBar('$(error) Bazel', `${action} failed`);
        outputChannel.appendLine(`Error: ${error.message}`);
        vscode.window.showErrorMessage(`Bazel ${action} error: ${error.message}`);
    }
}

// ============ Utilities ============

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

function runCommandStreaming(
    command: string,
    cwd: string,
    onData: (data: string) => void
): Promise<CommandResult> {
    return new Promise((resolve) => {
        const proc = cp.spawn('sh', ['-c', command], { cwd });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            onData(text);
        });

        proc.stderr.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            onData(text);
        });

        proc.on('close', (code) => {
            resolve({
                exitCode: code || 0,
                stdout,
                stderr,
            });
        });

        proc.on('error', (err) => {
            resolve({
                exitCode: 1,
                stdout,
                stderr: err.message,
            });
        });
    });
}

export function deactivate() {
    // Cleanup handled by subscriptions
}
