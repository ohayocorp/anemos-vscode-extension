const vscode = require('vscode');
const { exec, execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');

const execAsync = util.promisify(exec);
const fsUnlink = util.promisify(fs.unlink);

// Store terminal reference so it can be reused.
let anemosTerminal = null;

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
            anemosTerminal = vscode.window.createTerminal('Anemos Build');
        }

        anemosTerminal.show();

        // Change to workspace root and run build command.
        anemosTerminal.sendText(`cd "${workspaceRoot}"`);
        anemosTerminal.sendText(`"${anemosPath}" build index.js`);
    });

    // Listen for terminal close events to handle terminal disposal.
    vscode.window.onDidCloseTerminal(terminal => {
        if (terminal === anemosTerminal) {
            anemosTerminal = null;
        }
    }, null, context.subscriptions);

    context.subscriptions.push(buildCommand);
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