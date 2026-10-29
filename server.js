/**
 * Sleeping Teaching Assistant Problem - Node.js Server
 *
 * Bridges the C POSIX thread simulation engine with the browser UI via WebSockets.
 * Handles child process lifecycle, stdout event streaming, stdin command forwarding,
 * auto-compilation, and connection resilience.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const readline = require('readline');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const BINARY_NAME = process.platform === 'win32' ? 'sta.exe' : './sta';
const BINARY_PATH = path.join(__dirname, process.platform === 'win32' ? 'sta.exe' : 'sta');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory simulation state and event replay buffer
let simProcess = null;
let simReadline = null;
let currentConfig = {
    students: 5,
    chairs: 3,
    minHelp: 1200,
    maxHelp: 2500,
    minArr: 2000,
    maxArr: 4500,
    speed: 1.0
};
let isSimulationPaused = false;
let recentEvents = [];
const MAX_RECENT_EVENTS = 150;

/**
 * Ensure C binary is compiled.
 */
function ensureCompiled() {
    if (!fs.existsSync(BINARY_PATH)) {
        console.log('[Server] Simulation binary not found. Compiling via make...');
        try {
            execSync('make', { cwd: __dirname, stdio: 'inherit' });
            console.log('[Server] Compilation successful.');
        } catch (err) {
            console.error('[Server] Compilation failed:', err.message);
        }
    }
}

/**
 * Broadcast an event object to all active WebSocket clients.
 */
function broadcast(event) {
    // Record to rolling buffer
    recentEvents.push(event);
    if (recentEvents.length > MAX_RECENT_EVENTS) {
        recentEvents.shift();
    }

    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
        if (client.readyState === 1 /* OPEN */) {
            try {
                client.send(payload);
            } catch (err) {
                // Client dropped or error
            }
        }
    }
}

/**
 * Stop any currently running simulation child process cleanly.
 */
function stopSimulation() {
    return new Promise((resolve) => {
        if (!simProcess) {
            return resolve();
        }

        const proc = simProcess;
        simProcess = null;

        if (simReadline) {
            simReadline.close();
            simReadline = null;
        }

        let resolved = false;
        const cleanup = () => {
            if (!resolved) {
                resolved = true;
                resolve();
            }
        };

        proc.once('exit', cleanup);

        // Try graceful command via stdin first
        try {
            proc.stdin.write('QUIT\n');
        } catch (e) {}

        // Fallback SIGTERM after 400ms
        setTimeout(() => {
            if (!resolved) {
                try {
                    proc.kill('SIGTERM');
                } catch (e) {}
            }
        }, 400);

        // Hard kill fallback after 900ms
        setTimeout(() => {
            if (!resolved) {
                try {
                    proc.kill('SIGKILL');
                } catch (e) {}
                cleanup();
            }
        }, 900);
    });
}

/**
 * Start a new simulation child process with the specified parameters.
 */
async function startSimulation(config = {}) {
    await stopSimulation();
    ensureCompiled();

    currentConfig = {
        students: parseInt(config.students ?? currentConfig.students, 10),
        chairs: parseInt(config.chairs ?? currentConfig.chairs, 10),
        minHelp: parseInt(config.minHelp ?? currentConfig.minHelp, 10),
        maxHelp: parseInt(config.maxHelp ?? currentConfig.maxHelp, 10),
        minArr: parseInt(config.minArr ?? currentConfig.minArr, 10),
        maxArr: parseInt(config.maxArr ?? currentConfig.maxArr, 10),
        speed: parseFloat(config.speed ?? currentConfig.speed)
    };
    isSimulationPaused = false;
    recentEvents = [];

    const args = [
        String(currentConfig.students),
        String(currentConfig.chairs),
        String(currentConfig.minHelp),
        String(currentConfig.maxHelp),
        String(currentConfig.minArr),
        String(currentConfig.maxArr)
    ];

    console.log(`[Server] Spawning C engine: ${BINARY_NAME} ${args.join(' ')}`);

    try {
        simProcess = spawn(BINARY_NAME, args, {
            cwd: __dirname,
            stdio: ['pipe', 'pipe', 'pipe']
        });
    } catch (err) {
        console.error('[Server] Failed to spawn simulation process:', err);
        broadcast({ type: 'server_error', message: 'Failed to start C simulation binary.' });
        return false;
    }

    if (currentConfig.speed && currentConfig.speed !== 1.0) {
        try {
            simProcess.stdin.write(`SPEED ${currentConfig.speed}\n`);
        } catch (e) {}
    }

    simReadline = readline.createInterface({
        input: simProcess.stdout,
        crlfDelay: Infinity
    });

    simReadline.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            const event = JSON.parse(trimmed);
            broadcast(event);
        } catch (parseErr) {
            console.log('[STA stdout non-JSON]:', trimmed);
        }
    });

    simProcess.stderr.on('data', (chunk) => {
        console.error('[STA stderr]:', chunk.toString());
    });

    simProcess.on('exit', (code, signal) => {
        console.log(`[Server] Simulation exited with code ${code}, signal ${signal}`);
        broadcast({ type: 'sim_stopped', code, signal });
        simProcess = null;
    });

    return true;
}

/**
 * Forward a control command to the C process stdin.
 */
function sendCommand(cmd) {
    if (!simProcess || !simProcess.stdin) {
        return false;
    }
    try {
        simProcess.stdin.write(`${cmd}\n`);
        return true;
    } catch (err) {
        console.error(`[Server] Error writing command "${cmd}" to stdin:`, err.message);
        return false;
    }
}

/**
 * Handle user command incoming from UI (WS or REST).
 */
async function handleAction(action, payload = {}) {
    switch (action) {
        case 'start':
            return await startSimulation(payload);

        case 'pause':
            isSimulationPaused = true;
            return sendCommand('PAUSE');

        case 'resume':
            isSimulationPaused = false;
            return sendCommand('RESUME');

        case 'speed': {
            const speed = parseFloat(payload.speed || 1.0);
            currentConfig.speed = speed;
            return sendCommand(`SPEED ${speed}`);
        }

        case 'spawn':
        case 'add_student':
            return sendCommand('SPAWN');

        case 'reset':
            await stopSimulation();
            recentEvents = [];
            isSimulationPaused = false;
            broadcast({ type: 'sim_reset' });
            return true;

        default:
            console.warn(`[Server] Unknown action: ${action}`);
            return false;
    }
}

// REST Endpoints
app.get('/api/status', (req, res) => {
    res.json({
        running: !!simProcess,
        paused: isSimulationPaused,
        config: currentConfig,
        clients: wss.clients.size
    });
});

app.post('/api/action', async (req, res) => {
    const { action, ...payload } = req.body;
    const ok = await handleAction(action, payload);
    res.json({ success: ok, action });
});

// WebSocket Connection Management
wss.on('connection', (ws) => {
    // Send initial bootstrap packet to newly connected client
    ws.send(JSON.stringify({
        type: 'session_init',
        running: !!simProcess,
        paused: isSimulationPaused,
        config: currentConfig,
        history: recentEvents.slice(-60)
    }));

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            await handleAction(msg.action || msg.type, msg.payload || msg);
        } catch (err) {
            console.error('[Server] Invalid message from client:', err.message);
        }
    });
});

// Graceful process shutdown
function cleanupAndExit() {
    console.log('\n[Server] Terminating server and simulation process...');
    stopSimulation().then(() => {
        process.exit(0);
    });
}
process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);

// Auto-compile binary if needed and start HTTP server
ensureCompiled();
server.listen(PORT, () => {
    console.log(`[Server] Sleeping TA Visualizer running at http://localhost:${PORT}`);
});

