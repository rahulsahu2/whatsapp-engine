import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import qrcode from "qrcode";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

// your existing code continues here...


class WhatsAppEngine {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);

        // Get configuration from environment variables
        const APP_URL = process.env.APP_URL || "http://localhost:8000";
        const CORS_ORIGINS = [
            APP_URL,
            "http://localhost:8000",
            "http://127.0.0.1:8000",
        ];

        this.io = new Server(this.server, {
            cors: { origin: CORS_ORIGINS, methods: ["GET", "POST"] },
        });

        this.sock = null;
        this.qrCode = null;
        this.status = "disconnected";
        this.sessionPath = "./whatsapp-session";
        this.messages = new Map(); // Store recent messages
        this.conversations = new Map(); // Store conversations
        this.webhookUrl =
            process.env.WEBHOOK_URL || `${APP_URL}/webhook/whatsapp`;

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
                    setTimeout(() => this.connect(), 1000);
                    res.json({
                        success: true,
                        message: "Disconnected successfully",
                    });
                } else {
                    res.json({
                        success: false,
                        error: "Not connected to WhatsApp",
                    });
                }
            } catch (error) {
                this.cleanup();
                setTimeout(() => this.connect(), 1000);
                res.json({ success: true, message: "Disconnected" });
            }
        });

        this.app.post("/send", async (req, res) => {
            if (this.status !== "connected") {
                return res
                    .status(400)
                    .json({ error: "WhatsApp not connected" });
            }

            const { number, message } = req.body;
            if (!number || !message) {
                return res
                    .status(400)
                    .json({ error: "Number and message are required" });
            }

            try {
                const results = await this.sock.onWhatsApp(number);
                if (!results?.length) {
                    return res
                        .status(400)
                        .json({ error: "Invalid number format" });
                }

                const result = results[0];
                if (!result.exists) {
                    return res
                        .status(400)
                        .json({ error: "Number not found on WhatsApp" });
                }

                const sentMessage = await this.sock.sendMessage(result.jid, {
                    text: message,
                });

                // Send webhook notification for sent message
                this.sendWebhook("message_sent", {
                    phone_number: number,
                    message_id: sentMessage.key.id,
                    message_content: message,
                    timestamp: Date.now(),
                });

                res.json({
                    success: true,
                    message: "Message sent successfully",
                    messageId: sentMessage.key.id,
                });
            } catch (error) {
                res.status(500).json({ error: "Failed to send message" });
            }
        });

        this.app.get("/check/:number", async (req, res) => {
            if (this.status !== "connected") {
                return res
                    .status(400)
                    .json({ error: "WhatsApp not connected" });
            }

            try {
                const results = await this.sock.onWhatsApp(req.params.number);
                if (!results?.length) {
                    return res.json({
                        exists: false,
                        message: "Invalid number format",
                    });
                }

                const result = results[0];
                res.json({
                    exists: result.exists,
                    number: req.params.number,
                    message: result.exists
                        ? "Number exists on WhatsApp"
                        : "Number not found on WhatsApp",
                });
            } catch (error) {
                res.status(500).json({ error: "Failed to check number" });
            }
        });

        // Get recent messages from a specific number
        this.app.get("/messages/:number", async (req, res) => {
            if (this.status !== "connected") {
                return res
                    .status(400)
                    .json({ error: "WhatsApp not connected" });
            }

            try {
                const { number } = req.params;
                const limit = parseInt(req.query.limit) || 20;

                // Format number to JID
                const results = await this.sock.onWhatsApp(number);
                if (!results?.length || !results[0].exists) {
                    return res
                        .status(400)
                        .json({ error: "Number not found on WhatsApp" });
                }

                const jid = results[0].jid;

                // For now, return stored messages or empty array
                // This is a simplified implementation
                const storedMessages = this.messages.get(jid) || [];

                res.json({
                    success: true,
                    number: number,
                    messages: storedMessages.slice(-limit), // Get last N messages
                });
            } catch (error) {
                console.error("Error fetching messages:", error);
                res.status(500).json({ error: "Failed to fetch messages" });
            }
        });

        // Get conversation list
        this.app.get("/conversations", async (req, res) => {
            if (this.status !== "connected") {
                return res
                    .status(400)
                    .json({ error: "WhatsApp not connected" });
            }

            try {
                const limit = parseInt(req.query.limit) || 20;

                // For now, return conversations from stored messages
                const conversations = [];
                let count = 0;

                for (const [jid, messages] of this.conversations.entries()) {
                    if (count >= limit) break;

                    const number = jid
                        .replace("@s.whatsapp.net", "")
                        .replace("@g.us", "");
                    const isGroup = jid.includes("@g.us");

                    if (!isGroup) {
                        // Only individual chats
                        const lastMessage = messages[messages.length - 1];
                        conversations.push({
                            id: jid,
                            number: number,
                            name: number, // Use number as name for now
                            isGroup: false,
                            unreadCount: 0, // Simplified for now
                            lastMessage: lastMessage?.message || "No messages",
                            lastMessageTime:
                                lastMessage?.timestamp || Date.now(),
                            lastMessageFromMe: lastMessage?.fromMe || false,
                        });
                        count++;
                    }
                }

                res.json({
                    success: true,
                    conversations: conversations,
                });
            } catch (error) {
                console.error("Error fetching conversations:", error);
                res.status(500).json({
                    error: "Failed to fetch conversations",
                });
            }
        });

        // Mark messages as read
        this.app.post("/mark-read", async (req, res) => {
            if (this.status !== "connected") {
                return res
                    .status(400)
                    .json({ error: "WhatsApp not connected" });
            }

            try {
                const { number } = req.body;

                const results = await this.sock.onWhatsApp(number);
                if (!results?.length || !results[0].exists) {
                    return res
                        .status(400)
                        .json({ error: "Number not found on WhatsApp" });
                }

                const jid = results[0].jid;
                await this.sock.readMessages([
                    { remoteJid: jid, id: "", participant: "" },
                ]);

                res.json({ success: true, message: "Messages marked as read" });
            } catch (error) {
                console.error("Error marking messages as read:", error);
                res.status(500).json({
                    error: "Failed to mark messages as read",
                });
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
            const { state, saveCreds } = await useMultiFileAuthState(
                this.sessionPath
            );
            const { version } = await fetchLatestBaileysVersion();

            this.sock = makeWASocket({
                version,
                auth: state,
                printQRInTerminal: false,
            });

            this.sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    this.qrCode = await qrcode.toDataURL(qr);
                    this.status = "qr";
                    this.broadcast();
                }

                if (connection === "close") {
                    const shouldReconnect =
                        lastDisconnect?.error?.output?.statusCode !==
                        DisconnectReason.loggedOut;
                    if (shouldReconnect) {
                        setTimeout(() => this.connect(), 3000);
                    }
                    this.status = "disconnected";
                    this.qrCode = null;
                    this.broadcast();
                } else if (connection === "open") {
                    this.status = "connected";
                    this.qrCode = null;
                    this.broadcast();
                }
            });

            this.sock.ev.on("creds.update", saveCreds);

            // Listen for incoming messages
            this.sock.ev.on("messages.upsert", async (m) => {
                const message = m.messages[0];
                if (message && m.type === "notify") {
                    const jid = message.key.remoteJid;
                    const from = jid
                        .replace("@s.whatsapp.net", "")
                        .replace("@g.us", "");
                    const messageText =
                        message.message?.conversation ||
                        message.message?.extendedTextMessage?.text ||
                        "[Media/Other]";

                    // Store message
                    const messageData = {
                        id: message.key.id,
                        from: from,
                        message: messageText,
                        timestamp: message.messageTimestamp || Date.now(),
                        fromMe: message.key.fromMe || false,
                    };

                    // Store in messages map
                    if (!this.messages.has(jid)) {
                        this.messages.set(jid, []);
                    }
                    const messages = this.messages.get(jid);
                    messages.push(messageData);

                    // Keep only last 50 messages per chat
                    if (messages.length > 50) {
                        messages.shift();
                    }

                    // Store in conversations map
                    if (!this.conversations.has(jid)) {
                        this.conversations.set(jid, []);
                    }
                    this.conversations.get(jid).push(messageData);

                    // Emit to connected clients
                    this.io.emit("new-message", messageData);

                    // Send webhook for incoming message (if not from me)
                    if (!messageData.fromMe) {
                        this.sendWebhook("message_received", {
                            phone_number: from,
                            message_id: message.key.id,
                            message_content: messageText,
                            timestamp: messageData.timestamp,
                        });
                    }

                    console.log(`📨 New message from ${from}: ${messageText}`);
                }
            });

            // Listen for message status updates (read receipts, delivery)
            this.sock.ev.on("messages.update", async (updates) => {
                for (const update of updates) {
                    if (update.update.status) {
                        const status = update.update.status;
                        const messageId = update.key.id;

                        // Send webhook for status updates
                        if (status === 3) {
                            // Message delivered
                            this.sendWebhook("message_delivered", {
                                message_id: messageId,
                                timestamp: Date.now(),
                            });
                        } else if (status === 4) {
                            // Message read
                            this.sendWebhook("message_read", {
                                message_id: messageId,
                                timestamp: Date.now(),
                            });
                        }
                    }
                }
            });
        } catch (error) {
            console.error("Connection error:", error);
            setTimeout(() => this.connect(), 5000);
        }
    }

    cleanup() {
        this.sock = null;
        this.qrCode = null;
        this.status = "disconnected";
        if (fs.existsSync(this.sessionPath)) {
            fs.rmSync(this.sessionPath, { recursive: true, force: true });
        }
        this.broadcast();
    }

    broadcast() {
        this.io.emit("status", this.status);
        this.io.emit("qr", this.qrCode);
    }

    async sendWebhook(eventType, data) {
        try {
            const axios = require("axios");

            const webhookData = {
                event_type: eventType,
                timestamp: Date.now(),
                data: data,
            };

            console.log(`📤 Sending webhook: ${eventType}`, data);

            const response = await axios.post(this.webhookUrl, webhookData, {
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "WhatsApp-Engine/1.0",
                    Accept: "application/json",
                    "X-Requested-With": "XMLHttpRequest",
                },
                timeout: 10000,
                validateStatus: function (status) {
                    return status < 500; // Accept any status code less than 500
                },
            });

            if (response.status >= 400) {
                throw new Error(
                    `HTTP ${response.status}: ${response.statusText}`
                );
            }

            console.log(`✅ Webhook sent successfully: ${eventType}`);
        } catch (error) {
            console.error(
                `❌ Failed to send webhook: ${eventType}`,
                error.message
            );

            // Log more details for debugging
            if (error.response) {
                console.error(`Response status: ${error.response.status}`);
                console.error(`Response data:`, error.response.data);
            } else if (error.request) {
                console.error("No response received from webhook URL");
            }
        }
    }

    start() {
        const port = process.env.WHATSAPP_ENGINE_PORT || 3000;
        this.server.listen(port, () => {
            console.log(`🚀 WhatsApp Engine running on port ${port}`);
            console.log(
                `📡 CORS origins: ${process.env.APP_URL || "http://localhost:8000"
                }`
            );
            console.log(`🔗 Webhook URL: ${this.webhookUrl}`);
        });
    }
}

new WhatsAppEngine().start();
