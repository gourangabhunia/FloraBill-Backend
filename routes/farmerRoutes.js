
import express from "express";
import db from "../config/db.js";

const router = express.Router();

// =====================================
// HELPER: VALIDATE ID
// =====================================

const getValidId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// =====================================
// GET ALL FARMERS
// GET /api/farmers
// =====================================

router.get("/", async (req, res) => {
  try {
    const [farmers] = await db.query(`
      SELECT
        f.id,
        f.name,
        f.phone,
        f.village,
        f.created_at AS createdAt
      FROM farmers f
      ORDER BY f.id DESC
    `);

    res.json({ success: true, farmers });
  } catch (error) {
    console.error("Fetch Farmers Error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to fetch farmers",
    });
  }
});

// =====================================
// ADD FARMER
// POST /api/farmers
// =====================================

router.post("/", async (req, res) => {
  try {
    const { name, phone, village } = req.body;

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Farmer name is required",
      });
    }

    const farmerPhone =
      typeof phone === "string" ? phone.trim() : null;

    const farmerVillage =
      typeof village === "string" ? village.trim() : null;

    if (farmerPhone) {
      const [existing] = await db.query(
        "SELECT id FROM farmers WHERE phone = ?",
        [farmerPhone]
      );

      if (existing.length > 0) {
        return res.status(409).json({
          success: false,
          message: "This farmer phone number already exists",
        });
      }
    }

    const [result] = await db.query(
      `INSERT INTO farmers (name, phone, village)
       VALUES (?, ?, ?)`,
      [name.trim(), farmerPhone || null, farmerVillage || null]
    );

    const [rows] = await db.query(
      `SELECT id, name, phone, village,
              created_at AS createdAt
       FROM farmers WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: "Farmer added successfully",
      farmer: rows[0],
    });
  } catch (error) {
    console.error("Add Farmer Error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to add farmer",
    });
  }
});

// =====================================
// GET FARMER PROFILE + FINANCIAL SUMMARY
// GET /api/farmers/:id
// =====================================

router.get("/:id", async (req, res) => {
  try {
    const farmerId = getValidId(req.params.id);

    if (!farmerId) {
      return res.status(400).json({
        success: false,
        message: "Invalid farmer ID",
      });
    }

    const [farmers] = await db.query(
      `SELECT id, name, phone, village,
              created_at AS createdAt
       FROM farmers
       WHERE id = ?`,
      [farmerId]
    );

    if (farmers.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Farmer not found",
      });
    }

    const [purchaseRows] = await db.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS totalPurchase
       FROM farmer_purchases
       WHERE farmer_id = ?`,
      [farmerId]
    );

    const [paymentRows] = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS totalPayment
       FROM farmer_payments
       WHERE farmer_id = ?`,
      [farmerId]
    );

    const totalPurchase = Number(purchaseRows[0].totalPurchase);
    const totalPayment = Number(paymentRows[0].totalPayment);

    res.json({
      success: true,
      farmer: farmers[0],
      summary: {
        totalPurchase,
        totalPayment,
        remainingDue: totalPurchase - totalPayment,
      },
    });
  } catch (error) {
    console.error("Farmer Profile Error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to fetch farmer profile",
    });
  }
});

// =====================================
// ADD PURCHASE BILL WITH MULTIPLE FLOWERS
// POST /api/farmers/:id/purchases
// =====================================

router.post("/:id/purchases", async (req, res) => {
  const connection = await db.getConnection();

  try {
    const farmerId = getValidId(req.params.id);
    const { purchaseDate, note, items } = req.body;

    if (!farmerId) {
      return res.status(400).json({
        success: false,
        message: "Invalid farmer ID",
      });
    }

    if (!purchaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) {
      return res.status(400).json({
        success: false,
        message: "Valid purchase date is required (YYYY-MM-DD)",
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one flower item is required",
      });
    }

    let totalAmount = 0;

    const preparedItems = [];

    for (const item of items) {
      const flowerName =
        typeof item.flowerName === "string"
          ? item.flowerName.trim()
          : "";

      const quantity = Number(item.quantity);
      const rate = Number(item.rate);
      const unit =
        typeof item.unit === "string" && item.unit.trim()
          ? item.unit.trim()
          : "kg";

      if (
        !flowerName ||
        !Number.isFinite(quantity) ||
        !Number.isFinite(rate) ||
        quantity <= 0 ||
        rate < 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Every flower needs a name, valid quantity and rate",
        });
      }

      const amount = Number((quantity * rate).toFixed(2));
      totalAmount = Number((totalAmount + amount).toFixed(2));

      preparedItems.push({
        flowerName,
        quantity,
        unit,
        rate,
        amount,
      });
    }

    await connection.beginTransaction();

    const [farmerRows] = await connection.query(
      "SELECT id FROM farmers WHERE id = ?",
      [farmerId]
    );

    if (farmerRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Farmer not found",
      });
    }

    const [billResult] = await connection.query(
      `INSERT INTO farmer_purchases
       (farmer_id, purchase_date, total_amount, note)
       VALUES (?, ?, ?, ?)`,
      [farmerId, purchaseDate, totalAmount, note?.trim() || null]
    );

    for (const item of preparedItems) {
      await connection.query(
        `INSERT INTO farmer_purchase_items
         (purchase_id, flower_name, quantity, unit, rate, amount)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          billResult.insertId,
          item.flowerName,
          item.quantity,
          item.unit,
          item.rate,
          item.amount,
        ]
      );
    }

    await connection.commit();

    res.status(201).json({
      success: true,
      message: "Flower purchase saved successfully",
      purchase: {
        id: billResult.insertId,
        farmerId,
        purchaseDate,
        items: preparedItems,
        totalAmount,
        note: note?.trim() || null,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("Add Farmer Purchase Error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to save flower purchase",
    });
  } finally {
    connection.release();
  }
});

// =====================================
// GET ALL PURCHASE BILLS WITH FLOWER ITEMS
// GET /api/farmers/:id/purchases
// =====================================

router.get("/:id/purchases", async (req, res) => {
  try {
    const farmerId = getValidId(req.params.id);

    if (!farmerId) {
      return res.status(400).json({
        success: false,
        message: "Invalid farmer ID",
      });
    }

    const [farmerRows] = await db.query(
      "SELECT id FROM farmers WHERE id = ?",
      [farmerId]
    );

    if (farmerRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Farmer not found",
      });
    }

    const [purchases] = await db.query(
      `SELECT
         id,
         farmer_id AS farmerId,
         DATE_FORMAT(purchase_date, '%Y-%m-%d') AS purchaseDate,
         total_amount AS totalAmount,
         note
       FROM farmer_purchases
       WHERE farmer_id = ?
       ORDER BY purchase_date DESC, id DESC`,
      [farmerId]
    );

    for (const purchase of purchases) {
      const [items] = await db.query(
        `SELECT
           id,
           flower_name AS flowerName,
           quantity,
           unit,
           rate,
           amount
         FROM farmer_purchase_items
         WHERE purchase_id = ?
         ORDER BY id ASC`,
        [purchase.id]
      );

      purchase.totalAmount = Number(purchase.totalAmount);
      purchase.items = items.map((item) => ({
        ...item,
        quantity: Number(item.quantity),
        rate: Number(item.rate),
        amount: Number(item.amount),
      }));
    }

    res.json({ success: true, purchases });
  } catch (error) {
    console.error("Fetch Purchases Error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to fetch purchase history",
    });
  }
});


// =====================================
// UPDATE PURCHASE BILL
// PUT /api/farmers/:id/purchases/:purchaseId
// =====================================

router.put("/:id/purchases/:purchaseId", async (req, res) => {
  let connection;

  try {
    const farmerId = getValidId(req.params.id);
    const purchaseId = getValidId(req.params.purchaseId);
    const { purchaseDate, note, items } = req.body;

    if (!farmerId || !purchaseId) {
      return res.status(400).json({
        success: false,
        message: "Invalid farmer or purchase ID",
      });
    }

    if (!purchaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) {
      return res.status(400).json({
        success: false,
        message: "Valid purchase date is required",
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one flower item is required",
      });
    }

    let totalAmount = 0;
    const preparedItems = [];

    for (const item of items) {
      const flowerName =
        typeof item.flowerName === "string"
          ? item.flowerName.trim()
          : "";

      const quantity = Number(item.quantity);
      const rate = Number(item.rate);
      const unit =
        typeof item.unit === "string" && item.unit.trim()
          ? item.unit.trim()
          : "kg";

      if (
        !flowerName ||
        !Number.isFinite(quantity) ||
        !Number.isFinite(rate) ||
        quantity <= 0 ||
        rate < 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid flower item details",
        });
      }

      const amount = Number((quantity * rate).toFixed(2));
      totalAmount = Number((totalAmount + amount).toFixed(2));

      preparedItems.push({
        flowerName,
        quantity,
        unit,
        rate,
        amount,
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [existing] = await connection.query(
      `SELECT id FROM farmer_purchases
       WHERE id = ? AND farmer_id = ?`,
      [purchaseId, farmerId]
    );

    if (existing.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: "Purchase bill not found",
      });
    }

    await connection.query(
      `UPDATE farmer_purchases
       SET purchase_date = ?, total_amount = ?, note = ?
       WHERE id = ? AND farmer_id = ?`,
      [
        purchaseDate,
        totalAmount,
        typeof note === "string" ? note.trim() || null : null,
        purchaseId,
        farmerId,
      ]
    );

    await connection.query(
      "DELETE FROM farmer_purchase_items WHERE purchase_id = ?",
      [purchaseId]
    );

    for (const item of preparedItems) {
      await connection.query(
        `INSERT INTO farmer_purchase_items
         (purchase_id, flower_name, quantity, unit, rate, amount)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          purchaseId,
          item.flowerName,
          item.quantity,
          item.unit,
          item.rate,
          item.amount,
        ]
      );
    }

    await connection.commit();

    res.json({
      success: true,
      message: "Purchase bill updated successfully",
      purchase: {
        id: purchaseId,
        farmerId,
        purchaseDate,
        totalAmount,
        note,
        items: preparedItems,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();

    console.error("Update Farmer Purchase Error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to update purchase bill",
    });
  } finally {
    if (connection) connection.release();
  }
});


// =====================================
// DELETE PURCHASE BILL
// DELETE /api/farmers/:id/purchases/:purchaseId
// =====================================

router.delete("/:id/purchases/:purchaseId", async (req, res) => {
  let connection;

  try {
    const farmerId = getValidId(req.params.id);
    const purchaseId = getValidId(req.params.purchaseId);

    if (!farmerId || !purchaseId) {
      return res.status(400).json({
        success: false,
        message: "Invalid farmer or purchase ID",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [existing] = await connection.query(
      `SELECT id FROM farmer_purchases
       WHERE id = ? AND farmer_id = ?`,
      [purchaseId, farmerId]
    );

    if (existing.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: "Purchase bill not found",
      });
    }

    await connection.query(
      "DELETE FROM farmer_purchase_items WHERE purchase_id = ?",
      [purchaseId]
    );

    await connection.query(
      "DELETE FROM farmer_purchases WHERE id = ? AND farmer_id = ?",
      [purchaseId, farmerId]
    );

    await connection.commit();

    res.json({
      success: true,
      message: "Purchase bill deleted successfully",
    });
  } catch (error) {
    if (connection) await connection.rollback();

    console.error("Delete Farmer Purchase Error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to delete purchase bill",
    });
  } finally {
    if (connection) connection.release();
  }
});


// =====================================
// ADD PAYMENT TO FARMER
// POST /api/farmers/:id/payments
// =====================================

router.post("/:id/payments", async (req, res) => {
  try {
    const farmerId = getValidId(req.params.id);
    const { amount, paymentDate, paymentMode, note } = req.body;

    const paymentAmount = Number(amount);

    if (!farmerId) {
      return res.status(400).json({
        success: false,
        message: "Invalid farmer ID",
      });
    }

    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Payment amount must be greater than zero",
      });
    }

    if (!paymentDate || !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
      return res.status(400).json({
        success: false,
        message: "Valid payment date is required (YYYY-MM-DD)",
      });
    }

    const [farmerRows] = await db.query(
      "SELECT id FROM farmers WHERE id = ?",
      [farmerId]
    );

    if (farmerRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Farmer not found",
      });
    }

    const [result] = await db.query(
      `INSERT INTO farmer_payments
       (farmer_id, amount, payment_date, payment_mode, note)
       VALUES (?, ?, ?, ?, ?)`,
      [
        farmerId,
        paymentAmount,
        paymentDate,
        paymentMode?.trim() || null,
        note?.trim() || null,
      ]
    );

    res.status(201).json({
      success: true,
      message: "Farmer payment saved successfully",
      payment: {
        id: result.insertId,
        farmerId,
        amount: paymentAmount,
        paymentDate,
        paymentMode: paymentMode?.trim() || null,
        note: note?.trim() || null,
      },
    });
  } catch (error) {
    console.error("Add Farmer Payment Error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to save farmer payment",
    });
  }
});


 // =====================================
 // DELETE FARMER PAYMENT
 // DELETE /api/farmers/:id/payments/:paymentId
 // =====================================

router.delete("/:id/payments/:paymentId", async (req, res) => {
  try {
    const farmerId = getValidId(req.params.id);
    const paymentId = getValidId(req.params.paymentId);

    if (!farmerId || !paymentId) {
      return res.status(400).json({
        success: false,
        message: "Invalid farmer or payment ID",
      });
    }

    const [result] = await db.query(
      `DELETE FROM farmer_payments
       WHERE id = ? AND farmer_id = ?`,
      [paymentId, farmerId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Payment not found",
      });
    }

    res.json({
      success: true,
      message: "Payment deleted successfully",
    });
  } catch (error) {
    console.error("Delete Farmer Payment Error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to delete payment",
    });
  }
});


// =====================================
// GET FARMER PAYMENT HISTORY
// GET /api/farmers/:id/payments
// =====================================

router.get("/:id/payments", async (req, res) => {
  try {
    const farmerId = getValidId(req.params.id);

    if (!farmerId) {
      return res.status(400).json({
        success: false,
        message: "Invalid farmer ID",
      });
    }

    const [payments] = await db.query(
      `SELECT
         id,
         farmer_id AS farmerId,
         amount,
         DATE_FORMAT(payment_date, '%Y-%m-%d') AS paymentDate,
         payment_mode AS paymentMode,
         note
       FROM farmer_payments
       WHERE farmer_id = ?
       ORDER BY payment_date DESC, id DESC`,
      [farmerId]
    );

    res.json({
      success: true,
      payments: payments.map((payment) => ({
        ...payment,
        amount: Number(payment.amount),
      })),
    });
  } catch (error) {
    console.error("Fetch Farmer Payments Error:", error);
    res.status(500).json({
      success: false,
      message: "Unable to fetch farmer payments",
    });
  }
});

export default router;
