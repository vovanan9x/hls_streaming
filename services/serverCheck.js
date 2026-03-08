const cron = require('node-cron');
const { Client } = require('ssh2');
const { getDb } = require('../database');
const net = require('net');

/**
 * Check if a server is reachable via TCP connection
 */
function checkServerAlive(ip, port, timeout = 5000) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let resolved = false;

        socket.setTimeout(timeout);

        socket.on('connect', () => {
            resolved = true;
            socket.destroy();
            resolve(true);
        });

        socket.on('timeout', () => {
            if (!resolved) {
                resolved = true;
                socket.destroy();
                resolve(false);
            }
        });

        socket.on('error', () => {
            if (!resolved) {
                resolved = true;
                socket.destroy();
                resolve(false);
            }
        });

        try {
            socket.connect(port, ip);
        } catch (e) {
            if (!resolved) {
                resolved = true;
                resolve(false);
            }
        }
    });
}

/**
 * Check all servers and update their status
 */
async function checkAllServers() {
    const db = getDb();
    const servers = db.prepare('SELECT * FROM servers WHERE is_active = 1').all();

    for (const server of servers) {
        try {
            const isAlive = await checkServerAlive(server.ip, server.port);
            const status = isAlive ? 'live' : 'die';

            db.prepare(`
        UPDATE servers 
        SET status = ?, last_checked = datetime('now','localtime'), updated_at = datetime('now','localtime')
        WHERE id = ?
      `).run(status, server.id);

            console.log(`[ServerCheck] ${server.label} (${server.ip}:${server.port}) → ${status}`);
        } catch (err) {
            db.prepare(`
        UPDATE servers 
        SET status = 'die', last_checked = datetime('now','localtime'), updated_at = datetime('now','localtime')
        WHERE id = ?
      `).run(server.id);
            console.error(`[ServerCheck] Error checking ${server.label}:`, err.message);
        }
    }
}

/**
 * Start the cron job to check servers every minute
 */
function startServerCheckCron() {
    console.log('[Cron] Server health check started (every 1 minute)');

    // Run immediately on start
    checkAllServers().catch(console.error);

    // Then every minute
    cron.schedule('*/1 * * * *', () => {
        checkAllServers().catch(console.error);
    });
}

module.exports = { startServerCheckCron, checkAllServers };
