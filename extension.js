const vscode = require('vscode');
const { exec, execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');
const jsonc = require('jsonc-parser');

const execAsync = util.promisify(exec);
const fsUnlink = util.promisify(fs.unlink);

// Store terminal reference so it can be reused.
let anemosTerminal = null;
let anemosTerminalUsesPowerShell = false;

async function activate(context) {
    // Check for anemos binary at extension initialization.
    try {
        await ensureAnemosBinary(context);
        await ensureTypesAreUpToDate(context);
    } catch {
        vscode.window.showWarningMessage('Anemos binary not found and could not be downloaded. Some features may not work.');
    }

    // Register the anemos build command.
    let buildCommand = vscode.commands.registerCommand('anemos.build', async function () {
        // Get the workspace root path.
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder is open.');
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        let anemosPath;

        try {
            anemosPath = await ensureAnemosBinary(context);
        } catch {
            vscode.window.showErrorMessage('Failed to find or download Anemos binary.');
            return;
        }

        // Check if terminal exists, or if it has been disposed.
        if (!anemosTerminal || anemosTerminal.exitStatus !== undefined) {
            anemosTerminal = createAnemosTerminal('Anemos Build');
            anemosTerminalUsesPowerShell = process.platform === 'win32';
        } else if (process.platform === 'win32' && !anemosTerminalUsesPowerShell) {
            anemosTerminal.dispose();
            anemosTerminal = createAnemosTerminal('Anemos Build');
            anemosTerminalUsesPowerShell = true;
        }

        anemosTerminal.show();

        // Change to workspace root and run build command.
        anemosTerminal.sendText(`cd "${workspaceRoot}"`);
        if (process.platform === 'win32') {
            anemosTerminal.sendText(`& "${anemosPath}" build "index.js"`);
        } else {
            anemosTerminal.sendText(`"${anemosPath}" build index.js`);
        }
    });

    // Listen for terminal close events to handle terminal disposal.
    vscode.window.onDidCloseTerminal(terminal => {
        if (terminal === anemosTerminal) {
            anemosTerminal = null;
            anemosTerminalUsesPowerShell = false;
        }
    }, null, context.subscriptions);

    context.subscriptions.push(buildCommand);

    context.subscriptions.push(vscode.commands.registerCommand('anemos.addLaunchConfig', async function (resourceUri) {
        const targetUri = await pickTargetJsOrTsFile(resourceUri);
        if (!targetUri) {
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri) || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]);
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder is open.');
            return;
        }

        try {
            const didWrite = await ensureAnemosLaunchConfig(workspaceFolder, targetUri);
            if (!didWrite) {
                vscode.window.showInformationMessage('launch.json already contains an Anemos configuration.');
                return;
            }

            const openChoice = await vscode.window.showInformationMessage('Added Anemos configuration to .vscode/launch.json.', 'Open launch.json');
            if (openChoice === 'Open launch.json') {
                const launchUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, '.vscode', 'launch.json'));
                const doc = await vscode.workspace.openTextDocument(launchUri);
                await vscode.window.showTextDocument(doc);
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to update launch.json: ${e.message}`);
        }
    }));

    // Register a specific debug provider for 'anemos' that resolves the configuration
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('anemos', {
        provideDebugConfigurations: async (folder, token) => {
            let programPath;

            const options = {
                canSelectMany: false,
                openLabel: 'Select Entry File for launch.json',
                filters: {
                    'JavaScript/TypeScript': ['js', 'ts']
                }
            };

            if (workspaceRoot) {
                options.defaultUri = vscode.Uri.file(workspaceRoot);
            }

            const fileUri = await vscode.window.showOpenDialog(options);
            if (fileUri && fileUri[0]) {
                programPath = vscode.workspace.asRelativePath(fileUri[0], false);
            }

            // Fallback
            if (!programPath) {
                programPath = "${file}";
            }

            return [
                {
                    type: "anemos",
                    request: "launch",
                    name: "Anemos: Run Current File",
                    program: programPath
                }
            ];
        },
        resolveDebugConfiguration: async (folder, config, token) => {
            // If the program is missing, prompt for it using native dialog
            if (!config.program) {
                const workspaceRoot = folder ? folder.uri.fsPath : (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined);

                const options = {
                    canSelectMany: false,
                    openLabel: 'Select Anemos Entry File',
                    filters: {
                        'JavaScript/TypeScript': ['js', 'ts']
                    }
                };

                if (workspaceRoot) {
                    options.defaultUri = vscode.Uri.file(workspaceRoot);
                }

                const fileUri = await vscode.window.showOpenDialog(options);
                if (fileUri && fileUri[0]) {
                    config.program = fileUri[0].fsPath;
                } else {
                    // User cancelled
                    return undefined;
                }
            }

            // Resolve the final path (handle variables like ${file} if possible, but usually resolveDebugConfigurationWithSubstitutedVariables is better for that)
            // However, we can launch from here if we want to bypass DAP entirely.

            const workspaceRoot = folder ? folder.uri.fsPath : (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined);

            let anemosPath;
            try {
                anemosPath = await ensureAnemosBinary(context);
            } catch {
                vscode.window.showErrorMessage('Failed to find or download Anemos binary.');
                return undefined;
            }

            if (!anemosTerminal || anemosTerminal.exitStatus !== undefined) {
                anemosTerminal = createAnemosTerminal('Anemos Run');
                anemosTerminalUsesPowerShell = process.platform === 'win32';
            } else if (process.platform === 'win32' && !anemosTerminalUsesPowerShell) {
                anemosTerminal.dispose();
                anemosTerminal = createAnemosTerminal('Anemos Run');
                anemosTerminalUsesPowerShell = true;
            }
            anemosTerminal.show();

            const resolvedCwd = resolveCwd(workspaceRoot, config.cwd);
            if (resolvedCwd) {
                anemosTerminal.sendText(`cd "${resolvedCwd}"`);
            }

            const extraArgs = Array.isArray(config.args) ? config.args.filter(a => typeof a === 'string') : [];
            if (process.platform === 'win32') {
                const psArgs = extraArgs.map(quoteForPowerShell).join(' ');
                const command = `& "${anemosPath}" build "${config.program}" ${psArgs}`.trimEnd();
                anemosTerminal.sendText(command);
            } else {
                const argsPart = extraArgs.map(quoteForPosixShell).join(' ');
                const command = `${quoteForPosixShell(anemosPath)} build ${quoteForPosixShell(config.program)} ${argsPart}`.trimEnd();
                anemosTerminal.sendText(command);
            }

            return undefined; // We handled the execution, don't start a DAP session
        }
    }));
}

function createAnemosTerminal(name) {
    if (process.platform === 'win32') {
        return vscode.window.createTerminal({
            name,
            shellPath: 'powershell.exe',
            shellArgs: ['-NoLogo', '-NoProfile']
        });
    }

    return vscode.window.createTerminal(name);
}

function resolveCwd(workspaceRoot, cwd) {
    if (typeof cwd !== 'string' || cwd.trim() === '') {
        return workspaceRoot;
    }

    const trimmed = cwd.trim();

    if (workspaceRoot) {
        const substituted = trimmed.replaceAll('${workspaceFolder}', workspaceRoot);
        if (path.isAbsolute(substituted)) {
            return substituted;
        }

        return path.resolve(workspaceRoot, substituted);
    }

    return trimmed;
}

function quoteForPowerShell(value) {
    const str = String(value);
    return `'${str.replaceAll("'", "''")}'`;
}

function quoteForPosixShell(value) {
    const str = String(value);
    return `"${str.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

async function pickTargetJsOrTsFile(resourceUri) {
    if (resourceUri instanceof vscode.Uri) {
        const ext = path.extname(resourceUri.fsPath).toLowerCase();
        if (ext === '.js' || ext === '.ts') {
            return resourceUri;
        }
    }

    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document && editor.document.uri) {
        const ext = path.extname(editor.document.uri.fsPath).toLowerCase();
        if (ext === '.js' || ext === '.ts') {
            return editor.document.uri;
        }
    }

    const workspaceRoot = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0)
        ? vscode.workspace.workspaceFolders[0].uri
        : undefined;

    const options = {
        canSelectMany: false,
        openLabel: 'Select Entry File',
        filters: {
            'JavaScript/TypeScript': ['js', 'ts']
        },
        defaultUri: workspaceRoot
    };

    const fileUri = await vscode.window.showOpenDialog(options);
    if (!fileUri || !fileUri[0]) {
        return undefined;
    }

    return fileUri[0];
}

async function ensureAnemosLaunchConfig(workspaceFolder, targetUri) {
    const vscodeDir = path.join(workspaceFolder.uri.fsPath, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });

    const launchJsonPath = path.join(vscodeDir, 'launch.json');
    const targetRelativePath = toPosixPath(path.relative(workspaceFolder.uri.fsPath, targetUri.fsPath));

    let launchObject;
    let existingText;

    if (fs.existsSync(launchJsonPath)) {
        existingText = fs.readFileSync(launchJsonPath, 'utf8');
        const errors = [];
        launchObject = jsonc.parse(existingText, errors, { allowTrailingComma: true });
        if (errors.length > 0 || !launchObject || typeof launchObject !== 'object') {
            throw new Error('Existing launch.json could not be parsed as JSON.');
        }
    } else {
        launchObject = { version: '0.2.0', configurations: [] };
    }

    if (!launchObject.version) {
        launchObject.version = '0.2.0';
    }

    if (!Array.isArray(launchObject.configurations)) {
        launchObject.configurations = [];
    }

    const alreadyHasAnemos = launchObject.configurations.some(c => c && typeof c === 'object' && c.type === 'anemos');
    if (alreadyHasAnemos) {
        return false;
    }

    launchObject.configurations.push({
        type: 'anemos',
        request: 'launch',
        name: 'Anemos: Run Selected File',
        program: targetRelativePath
    });

    const newText = JSON.stringify(launchObject, null, 4) + '\n';
    fs.writeFileSync(launchJsonPath, newText, 'utf8');
    return true;
}

function toPosixPath(value) {
    return value.split(path.sep).join('/');
}

async function ensureAnemosBinary(context) {
    // Determine platform and appropriate filename.
    const platform = os.platform();
    let binaryName = 'anemos';
    if (platform === 'win32') {
        binaryName = 'anemos.exe';
    }

    // Check if anemos is in PATH.
    try {
        await execAsync(`${binaryName} --help`);
        return binaryName;
    } catch (error) {
    }

    // Check global storage for existing binary.
    const storagePath = context.globalStorageUri.fsPath;
    const binaryPath = path.join(storagePath, binaryName);
    if (fs.existsSync(binaryPath)) {
        return binaryPath;
    }

    try {
        // Ask user for permission to download.
        const downloadChoice = await vscode.window.showInformationMessage(
            'Anemos binary not found. Would you like to download it from GitHub?',
            'Yes', 'No'
        );

        if (downloadChoice !== 'Yes') {
            throw new Error('User did not consent to download Anemos binary.');
        }

        // Show download progress message.
        vscode.window.showInformationMessage('Downloading Anemos binary from GitHub...');

        // Storage path within the extension.
        if (!fs.existsSync(storagePath)) {
            fs.mkdirSync(storagePath, { recursive: true });
        }

        const releaseUrl = getGithubReleaseUrl();

        await downloadFile(releaseUrl, binaryPath);

        // Make binary executable on non-Windows platforms.
        if (platform !== 'win32') {
            fs.chmodSync(binaryPath, '755');
        }

        vscode.window.showInformationMessage('Anemos binary downloaded successfully.');
        return binaryPath;
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to download Anemos: ${error.message}`);
        throw error;
    }
}

function getGithubReleaseUrl() {
    const version = 'latest';
    let platformId;
    let archId;

    switch (os.platform()) {
        case 'win32':
            platformId = 'windows';
            break;
        case 'darwin':
            platformId = 'darwin';
            break;
        default:
            platformId = 'linux';
    }

    switch (os.arch()) {
        case 'x64':
            archId = 'amd64';
            break;
        case 'arm64':
            archId = 'arm64';
            break;
        default:
            archId = 'amd64';
    }

    return `https://github.com/ohayocorp/anemos/releases/${version}/download/anemos-${platformId}-${archId}`;
}

async function downloadFile(url, destPath) {
    try {
        const response = await new Promise((resolve, reject) => {
            https.get(url, resolve).on('error', reject);
        });

        // Handle redirects.
        if (response.statusCode === 302 || response.statusCode === 301) {
            return await downloadFile(response.headers.location, destPath);
        }

        if (response.statusCode !== 200) {
            throw new Error(`Failed to download: ${response.statusCode}`);
        }

        await writeResponseToFile(response, destPath);
    } catch (error) {
        // Clean up partial file in case of error.
        try {
            if (fs.existsSync(destPath)) {
                await fsUnlink(destPath);
            }
        } catch (unlinkError) {
            // Ignore errors during cleanup.
        }

        throw error;
    }
}

async function writeResponseToFile(response, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);

        response.pipe(file);

        file.on('finish', () => {
            file.close(() => resolve());
        });

        file.on('error', async (err) => {
            try {
                await fsUnlink(destPath);
            } catch (unlinkError) {
                // Ignore cleanup errors.
            }

            reject(err);
        });

        response.on('error', (err) => {
            reject(err);
        });
    });
}

function deactivate() { }

async function ensureTypesAreUpToDate(context) {
    try {
        const typesDir = path.join(__dirname, 'node_modules', 'anemos-typescript-plugin', '.anemos-types');

        const versionFilePath = path.join(typesDir, 'version.json');
        const currentVersion = await getAnemosToolVersion(context);

        let needsUpdate = true;

        if (fs.existsSync(versionFilePath)) {
            try {
                const versionData = JSON.parse(fs.readFileSync(versionFilePath, 'utf8'));
                needsUpdate = versionData.version !== currentVersion || currentVersion === "0.0.0";

                if (needsUpdate) {
                    console.log(`Types need update: current version ${currentVersion}, stored version ${versionData.version}`);
                } else {
                    console.log(`Types are up to date (version ${currentVersion})`);
                }
            } catch (e) {
                console.log(`Error reading version file: ${e}`);
                needsUpdate = true;
            }
        } else {
            console.log('No version file found, will generate types.');
        }

        // Generate types if needed.
        if (needsUpdate) {
            await generateAnemosTypes(context, typesDir);

            // Save the version info.
            fs.writeFileSync(
                versionFilePath,
                JSON.stringify({ version: currentVersion, generated: new Date().toISOString() }),
                'utf8'
            );
            console.log(`Updated version file to ${currentVersion}`);

            // Restart the TS server so that the new types are picked up.
            vscode.commands.executeCommand('typescript.restartTsServer');

        }
    } catch (e) {
        console.log(`Error ensuring types are up to date: ${e}`);
    }
}

async function getAnemosToolVersion(context) {
    try {
        const anemosPath = await ensureAnemosBinary(context);

        const versionOutput = execSync(`"${anemosPath}" --version`, { encoding: 'utf8' });
        const version = versionOutput.trim();

        console.log(`Detected anemos tool version: ${version}`);

        return version;
    } catch (e) {
        console.log(`Error getting anemos version: ${e}`);
        return 'unknown';
    }
}

async function generateAnemosTypes(context, outputDir) {
    try {
        console.log(`Removing all files in ${outputDir}`);
        fs.rmSync(outputDir, { recursive: true, force: true });

        console.log(`Generating Anemos type definitions in ${outputDir}`);
        const anemosPath = await ensureAnemosBinary(context);

        execSync(`"${anemosPath}" declarations "${outputDir}"`, { encoding: 'utf8' });

        console.log('Successfully generated type definitions.');
    } catch (e) {
        console.log(`Error generating type definitions: ${e}`);
        throw e;
    }
}

module.exports = { activate, deactivate };