const express = require("express");
const { Pool } = require("pg");
const multer = require("multer");
const csv = require("csv-parser");
const cors = require("cors");
const { Parser } = require("json2csv");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const API_KEY = process.env.API_KEY || "changeme";

function checkApiKey(req, res, next) {
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

const upload = multer({ dest: "uploads/" });

app.post("/import-students", checkApiKey, upload.single("file"), (req, res) => {
  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", async () => {
      try {
        for (const row of results) {
          await pool.query(
            "INSERT INTO students (htno, name, uid) VALUES ($1, $2, $3) ON CONFLICT (uid) DO NOTHING",
            [row.htno, row.name, row.uid]
          );
        }
        res.json({ success: true, count: results.length });
      } catch (err) {
        console.error("DB ERROR import:", err);
        res.status(500).json({ error: "Database error", details: err.message });
      } finally {
        try { fs.unlinkSync(req.file.path); } catch(e){}
      }
    });
});

app.post("/add-student", checkApiKey, async (req, res) => {
  const { htno, name, uid } = req.body;
  if (!htno || !name || !uid) return res.status(400).json({ error: "Missing fields" });
  try {
    await pool.query(
      "INSERT INTO students (htno, name, uid) VALUES ($1, $2, $3) ON CONFLICT (uid) DO NOTHING",
      [htno, name, uid]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("DB ERROR add-student:", err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

app.get("/check-card", checkApiKey, async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: "UID required" });

  try {
    const student = await pool.query("SELECT * FROM students WHERE uid = $1", [uid]);
    if (student.rows.length === 0) return res.status(404).json({ error: "Student not found" });

    const issued = await pool.query("SELECT * FROM issuance WHERE uid = $1", [uid]);
    res.json({
      student: student.rows[0],
      issued: issued.rows.length > 0,
      issuedRow: issued.rows[0] || null
    });
  } catch (err) {
    console.error("DB ERROR check-card:", err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

app.post("/mark-issued", checkApiKey, async (req, res) => {
  const { uid, issued_by } = req.body;
  if (!uid || !issued_by) return res.status(400).json({ error: "Missing fields" });

  try {
    // Fetch htno from students table
    const studentRes = await pool.query("SELECT htno FROM students WHERE uid = $1", [uid]);
    if (studentRes.rows.length === 0) {
      return res.status(400).json({ error: "Student not found" });
    }
    const htno = studentRes.rows[0].htno;

    // Insert into issuance with htno and current timestamp
    await pool.query(
      `INSERT INTO issuance (uid, issued_by, htno, issued_at) 
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      [uid, issued_by, htno]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("DB ERROR mark-issued:", err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

app.get("/export-issued", checkApiKey, async (req, res) => {
  try {
    const data = await pool.query(
      "SELECT s.htno, s.name, s.uid, i.issued_at, i.issued_by FROM issuance i JOIN students s ON i.uid = s.uid"
    );
    const parser = new Parser();
    const csvData = parser.parse(data.rows);
    res.header("Content-Type", "text/csv");
    res.attachment("issued_cards.csv");
    return res.send(csvData);
  } catch (err) {
    console.error("DB ERROR export-issued:", err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
