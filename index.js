import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from "@whiskeysockets/baileys";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import qrcode from "qrcode";
import dotenv from "dotenv";
import axios from "axios";
import P from "pino";
import { saveSession, getSession } from "./dbSessionStore.js";

dotenv.config();

class WhatsAppEngine {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);

        const APP_URL = process.env.APP_URL || "http://localhost:8000";
        const CORS_ORIGINS = [
            APP_URL,
            "http://localhost:8000",
            "http://127.0.0.1:8000",
            "http://localhost:3000",
            "http://127.0.0.1:3000"
        ];

        this.io = new Server(this.server, {
            cors: { origin: CORS_ORIGINS, methods: ["GET", "POST"] },
        });

        this.sock = null;
        this.qrCode = null;
        this.status = "disconnected";
        this.messages = new Map();
        this.conversations = new Map();
        this.webhookUrl = process.env.WEBHOOK_URL || `${APP_URL}/webhook/whatsapp`;

        this.setupMiddleware();
        this.setupRoutes();
        this.setupSocketIO();
        this.connect();
    }

    setupMiddleware() {
        this.app.use(express.json());
        this.app.use((req, res, next) => {
            res.header("Access-Control-Allow-Origin", "*");
            res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.header("Access-Control-Allow-Headers", "Content-Type");
            if (req.method === "OPTIONS") return res.sendStatus(200);
            next();
        });
    }

    setupRoutes() {
        this.app.get("/status", (req, res) => {
            res.json({ status: this.status, qr: this.qrCode });
        });

        this.app.post("/disconnect", async (req, res) => {
            try {
                if (this.sock && this.status === "connected") {
                    await this.sock.logout();
                    this.cleanup();
                    res.json({ success: true, message: "Disconnected" });
                } else {
                    res.json({ success: false, message: "Already disconnected" });
                }
            } catch (error) {
                console.error("Disconnect error:", error);
                res.status(500).json({ success: false, error: "Disconnect failed" });
            }
        });

        this.app.post("/send", async (req, res) => {
            if (this.status !== "connected") {
                return res.status(400).json({ error: "WhatsApp not connected" });
            }

            const { number, message } = req.body;
            if (!number || !message)
                return res.status(400).json({ error: "Number and message required" });

            try {
                const results = await this.sock.onWhatsApp(number);
                if (!results?.length || !results[0].exists) {
                    return res.status(400).json({ error: "Invalid number" });
                }

                const jid = results[0].jid;
                const sentMessage = await this.sock.sendMessage(jid, { text: message });

                await this.sendWebhook("message_sent", {
                    phone_number: number,
                    message_id: sentMessage.key.id,
                    message_content: message,
                    timestamp: Date.now(),
                });

                res.json({ success: true, messageId: sentMessage.key.id });
            } catch (err) {
                console.error("Send error:", err);
                res.status(500).json({ error: "Failed to send" });
            }
        });
    }

    setupSocketIO() {
        this.io.on("connection", (socket) => {
            socket.emit("status", this.status);
            if (this.qrCode) socket.emit("qr", this.qrCode);
        });
    }

    async connect() {
        try {
            const { version } = await fetchLatestBaileysVersion();

            // Try loading from DB
            let savedAuth = await getSession("default");
            let state = null;

            if (savedAuth && savedAuth.creds && savedAuth.keys) {
                console.log("🔁 Restoring WhatsApp session from DB...");
                state = {
                    creds: savedAuth.creds,
                    keys: makeCacheableSignalKeyStore(savedAuth.keys, P().child({ level: "silent" })),
                };
            } else {
                console.log("🆕 No saved session found. Starting new login...");
                state = { creds: { me: undefined }, keys: makeCacheableSignalKeyStore({}, P().child({ level: "silent" })) };
            }

            this.sock = makeWASocket({
                version,
                auth: state,
                printQRInTerminal: false,
                logger: P({ level: "silent" })
            });

            // Save credentials whenever updated
            this.sock.ev.on("creds.update", async () => {
                const authState = {
                    creds: this.sock.authState.creds,
                    keys: await this.sock.authState.keys.getAll(),
                };
                await saveSession("default", authState);
                console.log("💾 WhatsApp session updated in DB");
            });

            this.sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    this.qrCode = await qrcode.toDataURL(qr);
                    this.status = "qr";
                    this.broadcast();
                }

                if (connection === "open") {
                    this.status = "connected";
                    this.qrCode = null;
                    this.broadcast();
                    console.log("✅ WhatsApp connected");
                } else if (connection === "close") {
                    const shouldReconnect =
                        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                    if (shouldReconnect) setTimeout(() => this.connect(), 3000);
                    this.status = "disconnected";
                    this.qrCode = null;
                    this.broadcast();
                }
            });

        } catch (error) {
            console.error("❌ Connection error:", error);
            setTimeout(() => this.connect(), 5000);
        }
    }

    cleanup() {
        this.sock = null;
        this.qrCode = null;
        this.status = "disconnected";
        this.broadcast();
    }

    broadcast() {
        this.io.emit("status", this.status);
        this.io.emit("qr", this.qrCode);
    }

    async sendWebhook(eventType, data) {
        try {
            const payload = {
                event_type: eventType,
                timestamp: Date.now(),
                data,
            };
            await axios.post(this.webhookUrl, payload, {
                headers: { "Content-Type": "application/json" },
                timeout: 8000,
            });
        } catch (error) {
            console.error(`❌ Webhook failed (${eventType}):`, error.message);
        }
    }

    start() {
        const port = process.env.WHATSAPP_ENGINE_PORT || 3000;
        this.server.listen(port, () => {
            console.log(`🚀 WhatsApp Engine running on port ${port}`);
        });
    }
}

new WhatsAppEngine().start();
