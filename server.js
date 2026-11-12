
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import db from "./config/db.js";
import customerRoutes from "./routes/customerRoutes.js";
import farmerRoutes from "./routes/farmerRoutes.js";

// Load environment variables
dotenv.config();

const app = express();

// =====================================
// MIDDLEWARE
// =====================================

app.use(cors());
app.use(express.json());

// =====================================
// HOME ROUTE
// =====================================

app.get("/", (req, res) => {
  res.status(200).send("Gouranga Florist Backend is Running!");
});

// =====================================
// DATABASE CONNECTION TEST
// =====================================

app.get("/api/test-db", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT 1 AS result");

    res.status(200).json({
      success: true,
      message: "MySQL Connected Successfully!",
      data: rows,
    });

  } catch (error) {
    console.error("Database Error:", error.message);

    res.status(500).json({
      success: false,
      message: "MySQL Connection Failed",
    });
  }
});

// =====================================
// CUSTOMER ROUTES
// =====================================

app.use("/api/customers", customerRoutes);


// =====================================
// FARMER ROUTES
// =====================================

app.use("/api/farmers", farmerRoutes);

// =====================================
// 404 ROUTE
// =====================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// =====================================
// GLOBAL ERROR HANDLER
// =====================================

app.use((err, req, res, next) => {
  console.error("Server Error:", err);

  res.status(500).json({
    success: false,
    message: "Internal Server Error",
  });
});

// =====================================
// START SERVER
// =====================================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log("--------------------------------");
  console.log("Gouranga Florist Backend Started");
  console.log(`Server running on port ${PORT}`);
  console.log("--------------------------------");
});
