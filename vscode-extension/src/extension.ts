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
        vscode.commands.registerCommand('bazel-ide-toolkit.formatBuildFile', formatBuildFile),
        vscode.commands.registerCommand('bazel-ide-toolkit.showDeps', showDependencies),
        vscode.commands.registerCommand('bazel-ide-toolkit.showReverseDeps', showReverseDependencies),
        vscode.commands.registerCommand('bazel-ide-toolkit.codelens.build', (target: string) => executeBazelCommand('build', target)),
        vscode.commands.registerCommand('bazel-ide-toolkit.codelens.test', (target: string) => executeBazelCommand('test', target)),
        vscode.commands.registerCommand('bazel-ide-toolkit.codelens.run', (target: string) => executeBazelCommand('run', target)),
    );

    // Register CodeLens provider for BUILD files
    const config = vscode.workspace.getConfiguration('bazelIdeToolkit');
    if (config.get<boolean>('enableCodeLens')) {
        const codeLensProvider = new BazelCodeLensProvider();
        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider(
                [
                    { pattern: '**/BUILD' },
                    { pattern: '**/BUILD.bazel' },
                    { language: 'starlark' }
                ],
                codeLensProvider
            )
        );
    }

    // Register document formatting provider for Buildifier
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(
            [
                { pattern: '**/BUILD' },
                { pattern: '**/BUILD.bazel' },
                { pattern: '**/*.bzl' },
                { language: 'starlark' }
            ],
            new BuildifierFormattingProvider()
        )
    );

    // Auto-format on save if enabled
    context.subscriptions.push(
        vscode.workspace.onWillSaveTextDocument(async (event) => {
            const config = vscode.workspace.getConfiguration('bazelIdeToolkit');
            if (!config.get<boolean>('buildifierOnSave')) {
                return;
            }

            const doc = event.document;
            const fileName = path.basename(doc.fileName);
            if (fileName === 'BUILD' || fileName === 'BUILD.bazel' || doc.fileName.endsWith('.bzl')) {
                const edit = await formatWithBuildifier(doc);
                if (edit) {
                    event.waitUntil(Promise.resolve([edit]));
                }
            }
        })
    );

    // Set up file watchers if auto-refresh is enabled
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

// ============ CodeLens Provider ============

class BazelCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const codeLenses: vscode.CodeLens[] = [];
        const text = document.getText();
        const lines = text.split('\n');

        // Regex patterns for different rule types
        const rulePatterns = [
            // Binary rules (can build and run)
            { pattern: /^(cc_binary|py_binary|go_binary|rust_binary|java_binary|sh_binary)\s*\(/, canRun: true, canTest: false },
            // Test rules (can build and test)
            { pattern: /^(cc_test|py_test|go_test|rust_test|java_test|sh_test)\s*\(/, canRun: false, canTest: true },
            // Library rules (can only build)
            { pattern: /^(cc_library|py_library|go_library|rust_library|java_library|proto_library|filegroup)\s*\(/, canRun: false, canTest: false },
        ];

        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
            return codeLenses;
        }

        // Get package path from file
        const relativePath = path.relative(workspaceRoot, document.fileName);
        const packagePath = path.dirname(relativePath);

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];

            for (const { pattern, canRun, canTest } of rulePatterns) {
                if (pattern.test(line.trim())) {
                    // Find the name attribute
                    const targetName = findTargetName(lines, lineNum);
                    if (targetName) {
                        const target = `//${packagePath}:${targetName}`;
                        const range = new vscode.Range(lineNum, 0, lineNum, line.length);

                        // Always add Build
                        codeLenses.push(new vscode.CodeLens(range, {
                            title: '▶ Build',
                            command: 'bazel-ide-toolkit.codelens.build',
                            arguments: [target]
                        }));

                        // Add Test for test rules
                        if (canTest) {
                            codeLenses.push(new vscode.CodeLens(range, {
                                title: '🧪 Test',
                                command: 'bazel-ide-toolkit.codelens.test',
                                arguments: [target]
                            }));
                        }

                        // Add Run for binary rules
                        if (canRun) {
                            codeLenses.push(new vscode.CodeLens(range, {
                                title: '🚀 Run',
                                command: 'bazel-ide-toolkit.codelens.run',
                                arguments: [target]
                            }));
                        }
                    }
                    break;
                }
            }
        }

        return codeLenses;
    }
}

function findTargetName(lines: string[], startLine: number): string | undefined {
    // Look for name = "..." in the next few lines
    for (let i = startLine; i < Math.min(startLine + 20, lines.length); i++) {
        const match = lines[i].match(/name\s*=\s*["']([^"']+)["']/);
        if (match) {
            return match[1];
        }
        // Stop if we hit another rule or end of current rule
        if (i > startLine && lines[i].trim().match(/^\w+\s*\(/)) {
            break;
        }
    }
    return undefined;
}

// ============ Buildifier Formatting ============

class BuildifierFormattingProvider implements vscode.DocumentFormattingEditProvider {
    async provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
        const edit = await formatWithBuildifier(document);
        return edit ? [edit] : [];
    }
}

async function formatWithBuildifier(document: vscode.TextDocument): Promise<vscode.TextEdit | undefined> {
    const config = vscode.workspace.getConfiguration('bazelIdeToolkit');
    const buildifierPath = config.get<string>('buildifierPath') || 'buildifier';

    try {
        const result = await runCommandWithInput(
            buildifierPath,
            document.getText(),
            path.dirname(document.fileName)
        );

        if (result.exitCode === 0 && result.stdout !== document.getText()) {
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
            );
            return vscode.TextEdit.replace(fullRange, result.stdout);
        }
    } catch (error: any) {
        // Buildifier not installed - silently fail
        console.log('Buildifier not available:', error.message);
    }

    return undefined;
}

async function formatBuildFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const edit = await formatWithBuildifier(editor.document);
    if (edit) {
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.set(editor.document.uri, [edit]);
        await vscode.workspace.applyEdit(workspaceEdit);
        vscode.window.showInformationMessage('Formatted with Buildifier');
    } else {
        vscode.window.showInformationMessage('No formatting changes needed');
    }
}

// ============ Dependency Visualization ============

async function showDependencies() {
    const target = await promptForTarget('query deps');
    if (!target) {
        return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return;
    }

    outputChannel.clear();
    outputChannel.show(true);
    outputChannel.appendLine(`$ bazel query "deps(${target})" --output=graph`);
    outputChannel.appendLine('');

    updateStatusBar('$(sync~spin) Bazel', 'Querying dependencies...');

    try {
        const result = await runCommand(
            `bazel query "deps(${target}, 1)" --output=label 2>/dev/null`,
            workspaceRoot
        );

        if (result.exitCode === 0) {
            const deps = result.stdout.trim().split('\n').filter(d => d.startsWith('//'));

            outputChannel.appendLine(`Dependencies of ${target}:`);
            outputChannel.appendLine('');

            if (deps.length === 0) {
                outputChannel.appendLine('  (no dependencies)');
            } else {
                deps.forEach(dep => {
                    outputChannel.appendLine(`  → ${dep}`);
                });
            }

            outputChannel.appendLine('');
            outputChannel.appendLine(`Total: ${deps.length} direct dependencies`);

            updateStatusBar('$(check) Bazel', 'Query complete');
        } else {
            outputChannel.appendLine('Query failed');
            updateStatusBar('$(error) Bazel', 'Query failed');
        }
    } catch (error: any) {
        outputChannel.appendLine(`Error: ${error.message}`);
        updateStatusBar('$(error) Bazel', 'Query failed');
    }
}

async function showReverseDependencies() {
    const target = await promptForTarget('query rdeps');
    if (!target) {
        return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return;
    }

    outputChannel.clear();
    outputChannel.show(true);
    outputChannel.appendLine(`$ bazel query "rdeps(//..., ${target}, 1)"`);
    outputChannel.appendLine('');

    updateStatusBar('$(sync~spin) Bazel', 'Querying reverse dependencies...');

    try {
        const result = await runCommand(
            `bazel query "rdeps(//..., ${target}, 1)" --output=label 2>/dev/null | head -50`,
            workspaceRoot
        );

        if (result.exitCode === 0) {
            const rdeps = result.stdout.trim().split('\n').filter(d => d.startsWith('//') && d !== target);

            outputChannel.appendLine(`What depends on ${target}:`);
            outputChannel.appendLine('');

            if (rdeps.length === 0) {
                outputChannel.appendLine('  (nothing depends on this target)');
            } else {
                rdeps.forEach(dep => {
                    outputChannel.appendLine(`  ← ${dep}`);
                });
            }

            outputChannel.appendLine('');
            outputChannel.appendLine(`Total: ${rdeps.length} reverse dependencies (showing up to 50)`);

            updateStatusBar('$(check) Bazel', 'Query complete');
        } else {
            outputChannel.appendLine('Query failed');
            updateStatusBar('$(error) Bazel', 'Query failed');
        }
    } catch (error: any) {
        outputChannel.appendLine(`Error: ${error.message}`);
        updateStatusBar('$(error) Bazel', 'Query failed');
    }
}

// ============ File Watchers ============

function setupFileWatchers(context: vscode.ExtensionContext) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        return;
    }

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
        let command = 'bazel run @hedron_compile_commands//:refresh_all';

        const checkResult = await runCommand(
            'bazel query @hedron_compile_commands//:refresh_all',
            workspaceRoot
        );

        if (checkResult.exitCode !== 0) {
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
    vscode.window.showInformationMessage(`Auto-refresh ${!current ? 'enabled' : 'disabled'}`);
}

async function selectPlatform() {
    const platforms = [
        { label: '$(device-desktop) Linux x86_64', value: 'linux-x86_64' },
        { label: '$(device-desktop) macOS ARM64', value: 'macos-arm64' },
        { label: '$(device-desktop) Windows x86_64', value: 'windows-x86_64' },
        { label: '$(device-mobile) Android ARM64', value: 'android-arm64' },
        { label: '$(device-mobile) iOS ARM64', value: 'ios-arm64' },
    ];

    const selected = await vscode.window.showQuickPick(platforms, {
        placeHolder: 'Select target platform',
    });

    if (selected) {
        vscode.window.showInformationMessage(`Selected platform: ${selected.label}`);
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

    const recentTargets = await getRecentTargets(workspaceRoot, action);

    const items: vscode.QuickPickItem[] = recentTargets.map(t => ({
        label: t,
        description: action
    }));

    items.push({
        label: '$(edit) Enter target manually...',
        description: 'Type a Bazel target label'
    });

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Select target to ${action}`,
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
        // Ignore
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

    try {
        const result = await runCommand(
            `bazel query "kind(rule, rdeps(//..., ${relativePath}, 1))" --output=label 2>/dev/null | head -1`,
            workspaceRoot
        );
        if (result.exitCode === 0 && result.stdout.trim()) {
            return result.stdout.trim();
        }
    } catch {
        // Fall through
    }

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

function runCommandWithInput(command: string, input: string, cwd: string): Promise<CommandResult> {
    return new Promise((resolve) => {
        const proc = cp.spawn(command, [], { cwd, shell: true });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
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

        proc.stdin.write(input);
        proc.stdin.end();
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
