
import express from "express";
import db from "../config/db.js";

const router = express.Router();

// ============================================
// 1. GET ALL CUSTOMERS
// GET /api/customers
// ============================================

router.get("/", async (req, res) => {
  try {
    const [customers] = await db.query(`
      SELECT
        c.id,
        c.name,
        c.created_at AS createdAt,
        COALESCE(
          (SELECT SUM(b.total_amount)
           FROM bills b
           WHERE b.customer_id = c.id), 0
        ) AS totalBill,
        COALESCE(
          (SELECT SUM(p.amount)
           FROM payments p
           WHERE p.customer_id = c.id), 0
        ) AS totalPayment
      FROM customers c
      ORDER BY c.id DESC
    `);

    res.status(200).json({
      success: true,
      customers: customers.map((customer) => {
        const totalBill = Number(customer.totalBill);
        const totalPayment = Number(customer.totalPayment);

        return {
          ...customer,
          totalBill,
          totalPayment,
          totalDue: totalBill - totalPayment,
        };
      }),
    });
  } catch (error) {
    console.error("Fetch Customers Error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to fetch customers",
    });
  }
});


// ============================================
// 2. ADD NEW CUSTOMER
// POST /api/customers
// ============================================

router.post("/", async (req, res) => {
  try {
    const { name } = req.body;

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Customer name is required",
      });
    }

    const customerName = name.trim();

    const [existing] = await db.query(
      "SELECT id FROM customers WHERE LOWER(name) = LOWER(?)",
      [customerName]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: "This customer already exists",
      });
    }

    const [result] = await db.query(
      "INSERT INTO customers (name) VALUES (?)",
      [customerName]
    );

    const [rows] = await db.query(
      `SELECT id, name, created_at AS createdAt
       FROM customers WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: "Customer added successfully",
      customer: {
        ...rows[0],
        totalBill: 0,
        totalPayment: 0,
        totalDue: 0,
      },
    });
  } catch (error) {
    console.error("Add Customer Error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to add customer",
    });
  }
});


// ============================================
// 3. GET SINGLE CUSTOMER PROFILE
// GET /api/customers/:id
// ============================================

router.get("/:id", async (req, res) => {
  try {
    const customerId = Number(req.params.id);

    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid customer ID",
      });
    }

    const [customers] = await db.query(
      `SELECT
        c.id,
        c.name,
        c.created_at AS createdAt,
        COALESCE(
          (SELECT SUM(b.total_amount)
           FROM bills b
           WHERE b.customer_id = c.id), 0
        ) AS totalBill,
        COALESCE(
          (SELECT SUM(p.amount)
           FROM payments p
           WHERE p.customer_id = c.id), 0
        ) AS totalPayment
       FROM customers c
       WHERE c.id = ?`,
      [customerId]
    );

    if (customers.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    const customer = customers[0];
    const totalBill = Number(customer.totalBill);
    const totalPayment = Number(customer.totalPayment);

    res.status(200).json({
      success: true,
      customer: {
        ...customer,
        totalBill,
        totalPayment,
        totalDue: totalBill - totalPayment,
      },
    });
  } catch (error) {
    console.error("Customer Profile Error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to fetch customer profile",
    });
  }
});


// ============================================
// 4. CREATE DAILY FLOWER BILL
// POST /api/customers/:id/bills
// ============================================

router.post("/:id/bills", async (req, res) => {
  let connection;

  try {
    const customerId = Number(req.params.id);
    const { billDate, items } = req.body;

    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid customer ID",
      });
    }

    if (
      typeof billDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(billDate)
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid bill date is required",
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Add at least one flower",
      });
    }

    for (const item of items) {
      const quantity = Number(item.quantity);
      const rate = Number(item.rate);

      if (
        typeof item.flowerName !== "string" ||
        !item.flowerName.trim() ||
        item.quantity === "" ||
        item.rate === "" ||
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        !Number.isFinite(rate) ||
        rate < 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid flower details",
        });
      }
    }

    const totalPaise = items.reduce((sum, item) => {
      return (
        sum +
        Math.round(
          Number(item.quantity) * Number(item.rate) * 100
        )
      );
    }, 0);

    const totalAmount = totalPaise / 100;

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [customers] = await connection.query(
      "SELECT id FROM customers WHERE id = ?",
      [customerId]
    );

    if (customers.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    const [billResult] = await connection.query(
      `INSERT INTO bills
       (customer_id, bill_date, total_amount)
       VALUES (?, ?, ?)`,
      [customerId, billDate, totalAmount]
    );

    const billId = billResult.insertId;

    const values = items.map((item) => {
      const quantity = Number(item.quantity);
      const rate = Number(item.rate);
      const amount =
        Math.round(quantity * rate * 100) / 100;

      return [
        billId,
        item.flowerName.trim(),
        quantity,
        rate,
        amount,
      ];
    });

    await connection.query(
      `INSERT INTO bill_items
       (bill_id, flower_name, quantity, rate, amount)
       VALUES ?`,
      [values]
    );

    await connection.commit();

    res.status(201).json({
      success: true,
      message: "Daily bill created successfully",
      bill: {
        id: billId,
        customerId,
        billDate,
        totalAmount,
        items: items.map((item) => ({
          flowerName: item.flowerName.trim(),
          quantity: Number(item.quantity),
          rate: Number(item.rate),
          amount:
            Math.round(
              Number(item.quantity) * Number(item.rate) * 100
            ) / 100,
        })),
      },
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Rollback Error:", rollbackError);
      }
    }

    console.error("Create Bill Error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to create daily bill",
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});


// ============================================
// 5. GET CUSTOMER DAILY BILLS
// GET /api/customers/:id/bills
// ============================================

router.get("/:id/bills", async (req, res) => {
  try {
    const customerId = Number(req.params.id);

    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid customer ID",
      });
    }

    const [customers] = await db.query(
      "SELECT id FROM customers WHERE id = ?",
      [customerId]
    );

    if (customers.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    const [bills] = await db.query(
      `SELECT
        id,
        customer_id AS customerId,
        DATE_FORMAT(bill_date, '%Y-%m-%d') AS billDate,
        total_amount AS totalAmount,
        created_at AS createdAt
       FROM bills
       WHERE customer_id = ?
       ORDER BY bill_date DESC, id DESC`,
      [customerId]
    );

    let allItems = [];

    if (bills.length > 0) {
      const billIds = bills.map((bill) => bill.id);
      const placeholders = billIds.map(() => "?").join(",");

      const [items] = await db.query(
        `SELECT
          id,
          bill_id AS billId,
          flower_name AS flowerName,
          quantity,
          rate,
          amount
         FROM bill_items
         WHERE bill_id IN (${placeholders})
         ORDER BY id ASC`,
        billIds
      );

      allItems = items;
    }

    const billsWithItems = bills.map((bill) => ({
      ...bill,
      totalAmount: Number(bill.totalAmount),
      items: allItems
        .filter((item) => Number(item.billId) === Number(bill.id))
        .map((item) => ({
          ...item,
          quantity: Number(item.quantity),
          rate: Number(item.rate),
          amount: Number(item.amount),
        })),
    }));

    res.status(200).json({
      success: true,
      bills: billsWithItems,
    });
  } catch (error) {
    console.error("Fetch Bills Error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to fetch daily bills",
    });
  }
});


// ============================================
// 6. ADD CUSTOMER PAYMENT
// POST /api/customers/:id/payments
// ============================================

router.post("/:id/payments", async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    const { amount, paymentDate, note } = req.body;

    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid customer ID",
      });
    }

    const paymentAmount = Number(amount);

    if (
      amount === "" ||
      amount === undefined ||
      !Number.isFinite(paymentAmount) ||
      paymentAmount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid payment amount",
      });
    }

    if (
      typeof paymentDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid payment date is required",
      });
    }

    const [customers] = await db.query(
      "SELECT id FROM customers WHERE id = ?",
      [customerId]
    );

    if (customers.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    const finalAmount =
      Math.round(paymentAmount * 100) / 100;

    const paymentNote =
      typeof note === "string" ? note.trim() : "";

    const [result] = await db.query(
      `INSERT INTO payments
       (customer_id, amount, payment_date, note)
       VALUES (?, ?, ?, ?)`,
      [customerId, finalAmount, paymentDate, paymentNote]
    );

    const [payments] = await db.query(
      `SELECT
        id,
        customer_id AS customerId,
        amount,
        DATE_FORMAT(payment_date, '%Y-%m-%d') AS paymentDate,
        note
       FROM payments
       WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: "Payment added successfully",
      payment: {
        ...payments[0],
        amount: Number(payments[0].amount),
      },
    });
  } catch (error) {
    console.error("Add Payment Error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to add payment",
    });
  }
});


// ============================================
// 7. GET CUSTOMER PAYMENT HISTORY
// GET /api/customers/:id/payments
// ============================================

router.get("/:id/payments", async (req, res) => {
  try {
    const customerId = Number(req.params.id);

    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid customer ID",
      });
    }

    const [customers] = await db.query(
      "SELECT id FROM customers WHERE id = ?",
      [customerId]
    );

    if (customers.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    const [payments] = await db.query(
      `SELECT
        id,
        customer_id AS customerId,
        amount,
        DATE_FORMAT(payment_date, '%Y-%m-%d') AS paymentDate,
        note
       FROM payments
       WHERE customer_id = ?
       ORDER BY payment_date DESC, id DESC`,
      [customerId]
    );

    const totalPayment = payments.reduce(
      (sum, payment) => sum + Number(payment.amount),
      0
    );

    res.status(200).json({
      success: true,
      totalPayment,
      payments: payments.map((payment) => ({
        ...payment,
        amount: Number(payment.amount),
      })),
    });
  } catch (error) {
    console.error("Fetch Payments Error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to fetch payment history",
    });
  }
});


// ============================================
// 8. DELETE CUSTOMER DAILY BILL
// DELETE /api/customers/:id/bills/:billId
// ============================================

router.delete("/:id/bills/:billId", async (req, res) => {
  let connection;

  try {
    const customerId = Number(req.params.id);
    const billId = Number(req.params.billId);

    if (
      !Number.isInteger(customerId) ||
      customerId <= 0 ||
      !Number.isInteger(billId) ||
      billId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid customer or bill ID",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    // Check that this bill belongs to this customer
    const [bills] = await connection.query(
      `SELECT id FROM bills
       WHERE id = ? AND customer_id = ?`,
      [billId, customerId]
    );

    if (bills.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: "Bill not found for this customer",
      });
    }

    // Delete bill items first
    await connection.query(
      "DELETE FROM bill_items WHERE bill_id = ?",
      [billId]
    );

    // Delete the bill
    await connection.query(
      "DELETE FROM bills WHERE id = ? AND customer_id = ?",
      [billId, customerId]
    );

    await connection.commit();

    res.status(200).json({
      success: true,
      message: "Bill deleted successfully",
      deletedBillId: billId,
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Rollback Error:", rollbackError);
      }
    }

    console.error("Delete Bill Error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to delete bill",
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});


// ============================================
// 9. DELETE CUSTOMER PAYMENT
// DELETE /api/customers/:id/payments/:paymentId
// ============================================

router.delete("/:id/payments/:paymentId", async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    const paymentId = Number(req.params.paymentId);

    if (
      !Number.isInteger(customerId) ||
      customerId <= 0 ||
      !Number.isInteger(paymentId) ||
      paymentId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid customer or payment ID",
      });
    }

    // Delete only if payment belongs to this customer
    const [result] = await db.query(
      `DELETE FROM payments
       WHERE id = ? AND customer_id = ?`,
      [paymentId, customerId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Payment not found for this customer",
      });
    }

    // Totals are calculated from the payments table,
    // so the next customer/profile request will show updated values.
    res.status(200).json({
      success: true,
      message: "Payment deleted successfully",
      deletedPaymentId: paymentId,
    });
  } catch (error) {
    console.error("Delete Payment Error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to delete payment",
    });
  }
});


export default router;
