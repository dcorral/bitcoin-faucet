require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const Client = require("bitcoin-core");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const rateLimit = require("express-rate-limit");
const basicAuth = require("express-basic-auth");

const {
  API_PORT,
  BTC_NODE_URL,
  BTC_NODE_PORT,
  BTC_USER,
  BTC_PASS,
  BTC_WALLET,
  BTC_AMOUNT,
  FRONTEND_URL,
  CAPTCHA_SECRET,
  CAPTCHA_KEY,
  GITHUB_LINK,
  TWITTER_LINK,
  AUTH_USERNAME,
  AUTH_PASSWORD,
} = process.env;

let authMiddleware;
if (AUTH_USERNAME && AUTH_PASSWORD) {
  authMiddleware = basicAuth({
    users: { [AUTH_USERNAME]: AUTH_PASSWORD },
    challenge: true,
  });
} else {
  authMiddleware = (req, res, next) => next();
}

const limiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  message: {
    success: false,
    error: "Too many requests, please try again later.",
  },
});

const app = express();
app.set("trust proxy", true);

const allowedOrigins = (FRONTEND_URL || "http://localhost:3000").split(",");

const corsOptions = {
  origin: function (origin, callback) {
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
};

app.use(cors(corsOptions));
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
      );`,
      (err) => {
        if (err)
          console.error("Error creating transactions table:", err.message);
      },
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        txid TEXT,
        status TEXT DEFAULT 'pending',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );`,
      (err) => {
        if (err) console.error("Error creating queue table:", err.message);
      },
    );
  }
});

const client = new Client({
  network: "testnet",
  host: BTC_NODE_URL.replace(/^http(s)?:\/\//, ""),
  port: BTC_NODE_PORT,
  username: BTC_USER,
  password: BTC_PASS,
  allowDefaultWallet: true,
  wallet: BTC_WALLET,
});

app.use(authMiddleware);

app.get("/", (req, res) => {
  const indexHtmlPath = path.join(__dirname, "public", "index.html");

  fs.readFile(indexHtmlPath, "utf8", (err, data) => {
    if (err) {
      console.error("Error reading index.html:", err.message);
      return res.status(500).send("Error loading the page.");
    }

    const modifiedHtml = data
      .replace(/__API_BASE_URL__/g, FRONTEND_URL)
      .replace(/__GITHUB_LINK__/g, GITHUB_LINK)
      .replace(/__BTC_AMOUNT__/g, BTC_AMOUNT)
      .replace(/__CAPTCHA_KEY__/g, CAPTCHA_KEY)
      .replace(/__TWITTER_LINK__/g, TWITTER_LINK);

    res.send(modifiedHtml);
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.use("/sendbtc", limiter, authMiddleware);
app.post("/sendbtc", async (req, res) => {
  const { recaptchaToken, address } = req.body;

  if (req.body.email) {
    return res.status(400).json({ success: false, error: "Fuck off" });
  }

  if (!address) {
    return res.status(400).json({ success: false, error: "Invalid address." });
  }

  if (!recaptchaToken) {
    return res
      .status(400)
      .json({ success: false, error: "Captcha is required." });
  }

  // Verify reCAPTCHA
  try {
    const captchaResponse = await fetch(
      `https://challenges.cloudflare.com/turnstile/v0/siteverify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `secret=${CAPTCHA_SECRET}&response=${recaptchaToken}`,
      },
    );

    const captchaResult = await captchaResponse.json();
    if (!captchaResult.success) {
      return res.status(403).json({ success: false, error: "Captcha failed." });
    }
  } catch (error) {
    console.error("Error verifying reCAPTCHA:", error.message);
    return res
      .status(500)
      .json({ success: false, error: "Captcha verification failed." });
  }
  db.run(`INSERT INTO queue (address) VALUES (?)`, [address], function (err) {
    if (err) {
      console.error("Error inserting into queue:", err.message);
      return res
        .status(500)
        .json({ success: false, error: "Internal server error." });
    }

    const newRequestId = this.lastID;

    db.all(
      `SELECT id FROM queue WHERE status='pending' ORDER BY id ASC`,
      [],
      (err, rows) => {
        if (err) {
          console.error("Error getting queue position:", err.message);
          return res
            .status(500)
            .json({ success: false, error: "Internal server error." });
        }

        const ids = rows.map((r) => r.id);
        const position = ids.indexOf(newRequestId) + 1;

        res.json({
          success: true,
          message: "Your request is added to the queue! ;)",
          queueId: newRequestId,
          position,
        });
      },
    );
  });
});

app.use("/transactions", authMiddleware);
app.get("/transactions", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || null;
  if (limit > 10) limit = 10;

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

app.use("/queue-status", authMiddleware);
app.get("/queue-status", (req, res) => {
  const { queueId } = req.query;
  if (!queueId) {
    return res.status(400).json({ success: false, error: "Missing queueId." });
  }

  db.get(`SELECT id, status FROM queue WHERE id=?`, [queueId], (err, row) => {
    if (err) {
      console.error("Error retrieving queue status:", err.message);
      return res
        .status(500)
        .json({ success: false, error: "Internal server error." });
    }
    if (!row) {
      return res.status(404).json({ success: false, error: "Not found." });
    }

    if (row.status === "pending") {
      db.all(
        `SELECT id FROM queue WHERE status='pending' ORDER BY id ASC`,
        [],
        (err, rows) => {
          if (err) {
            console.log(err);
            return res
              .status(500)
              .json({ success: false, error: "Internal server error." });
          }
          const ids = rows.map((r) => r.id);
          const position = ids.indexOf(row.id) + 1;
          res.json({ success: true, status: "pending", position });
        },
      );
    } else if (row.status === "completed") {
      db.get(`SELECT txid FROM queue WHERE id=?`, [row.id], (err, txRow) => {
        if (err) {
          console.log(err);
          return res
            .status(500)
            .json({ success: false, error: "Internal server error." });
        }
        res.json({
          success: true,
          status: "completed",
          txid: txRow?.txid || null,
        });
      });
    } else {
      res.json({ success: true, status: row.status });
    }
  });
});

async function processQueue() {
  db.all(
    `SELECT * FROM queue WHERE status='pending' ORDER BY id ASC LIMIT 5000`,
    [],
    async (err, rows) => {
      if (err) {
        console.error("Error fetching queue:", err.message);
        return; // Try again next time
      }
      if (!rows || rows.length === 0) {
        // No pending requests
        return;
      }

      const sends = {};
      const requestIds = rows.map((r) => r.id);
      const amount = parseFloat(BTC_AMOUNT);
      const validRows = [];
      for (const row of rows) {
        try {
          const validateResult = await client.validateAddress(row.address);
          if (validateResult.isvalid) {
            sends[row.address] = amount;
            validRows.push(row);
          } else {
            db.run(
              `UPDATE queue SET status='invalid' WHERE id=?`,
              [row.id],
              (err) => {
                if (err)
                  console.error("Error marking invalid address:", err.message);
              },
            );
          }
        } catch (validateError) {
          console.error(
            `Error validating address ${row.address}:`,
            validateError.message,
          );
          db.run(
            `UPDATE queue SET status='invalid' WHERE id=?`,
            [row.id],
            (err) => {
              if (err)
                console.error("Error marking invalid address:", err.message);
            },
          );
        }
      }
      try {
        const txid = await client.sendMany(
          "",
          sends,
          1, // minconf
          "", // comment
          [], // subtractFeeFrom (list of addresses to subtract fee from)
          true, // replaceable (RBF)
          undefined, // conf_target
          "unset", // estimate_mode
          10, // fee_rate in sat/vB (this sets the fee rate)
        );

        // Update queue status to completed
        const placeholders = requestIds.map(() => "?").join(",");
        db.run(
          `UPDATE queue SET status='completed', txid=? WHERE id IN (${placeholders})`,
          [txid, ...requestIds],
          (err) => {
            if (err) {
              console.error("Error updating queue for batch:", err.message);
            }
          },
        );

        const insertStmt = db.prepare(
          `INSERT INTO transactions (address, amount) VALUES (?, ?)`,
        );
        for (const addr of Object.keys(sends)) {
          insertStmt.run([addr, sends[addr]], (err) => {
            if (err) console.error("Error inserting transaction:", err.message);
          });
        }
        insertStmt.finalize();

        console.log(
          `Processed ${rows.length} queued requests in a single transaction: ${txid}`,
        );
      } catch (error) {
        console.error("Error sending BTC from queue:", error.message);
      }
    },
  );
}

setInterval(processQueue, 15000);

app.listen(API_PORT, () =>
  console.log(`Faucet backend running on port ${API_PORT}`),
);
