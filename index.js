require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const Client = require("bitcoin-core");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const rateLimit = require("express-rate-limit");

const {
  API_PORT,
  BTC_NODE_URL,
  BTC_NODE_PORT,
  BTC_USER,
  BTC_PASS,
  BTC_WALLET,
  BTC_AMOUNT,
} = process.env;

// Define rate limiting rules
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 60 minutes
  max: 5, // Limit each IP to 5 requests per window
  message: {
    success: false,
    error: "Too many requests, please try again later.",
  },
});

const app = express();

app.use(cors());
app.use(bodyParser.json());

const db = new sqlite3.Database("./faucet.db", (err) => {
  if (err) {
    console.error("Error opening database:", err.message);
  } else {
    console.log("Connected to SQLite database.");
    db.run(
      `CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        amount REAL NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      (err) => {
        if (err) {
          console.error("Error creating table:", err.message);
        }
      },
    );
  }
});

const client = new Client({
  network: "testnet",
  host: BTC_NODE_URL.replace(/^http(s)?:\/\//, ""), // Strip "http://" or "https://"
  port: BTC_NODE_PORT,
  username: BTC_USER,
  password: BTC_PASS,
  allowDefaultWallet: true,
  wallet: BTC_WALLET,
});

// Faucet endpoint
app.use("/sendbtc", limiter);
app.post("/sendbtc", async (req, res) => {
  const { address } = req.body;

  console.log("Received request for address:", address);
  if (!address) {
    return res.status(400).json({ success: false, error: "Invalid address" });
  }

  try {
    const amount = parseFloat(BTC_AMOUNT);

    const txid = await client.sendToAddress(address, amount);

    db.run(
      `INSERT INTO transactions (address, amount) VALUES (?, ?)`,
      [address, amount],
      (err) => {
        if (err) {
          console.error("Error inserting into database:", err.message);
        } else {
          console.log("Transaction logged successfully.");
        }
      },
    );

    res.json({ success: true, txid });
  } catch (error) {
    console.error("Error sending BTC:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/transactions", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || null;
  let query = `SELECT * FROM transactions ORDER BY timestamp DESC`;

  if (limit) {
    query += ` LIMIT ?`;
  }

  db.all(query, limit ? [limit] : [], (err, rows) => {
    if (err) {
      console.error("Error retrieving transactions:", err.message);
      res.status(500).json({ success: false, error: err.message });
    } else {
      res.json({ success: true, transactions: rows });
    }
  });
});

app.listen(API_PORT, () => {
  console.log(`Faucet backend running on port ${API_PORT}`);
});
