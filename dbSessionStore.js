import mysql from 'mysql2/promise';
import dotenv from "dotenv";

dotenv.config();

const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
});

// ✅ Create table if not exists
await db.execute(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(100) UNIQUE,
        data JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
`);

export const saveSession = async (sessionId, data) => {
    const json = JSON.stringify(data);
    await db.execute(
        `INSERT INTO whatsapp_sessions (session_id, data)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = CURRENT_TIMESTAMP`,
        [sessionId, json]
    );
};

export const getSession = async (sessionId) => {
    const [rows] = await db.execute(
        `SELECT data FROM whatsapp_sessions WHERE session_id = ?`,
        [sessionId]
    );
    if (rows.length > 0) {
        try {
            return JSON.parse(rows[0].data);
        } catch {
            return null;
        }
    }
    return null;
};

export const deleteSession = async (sessionId) => {
    await db.execute(
        `DELETE FROM whatsapp_sessions WHERE session_id = ?`,
        [sessionId]
    );
};

export default db;
