import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { deletePrivateObject } from "../services/storage.js";

export const adminProductsRouter = Router();
adminProductsRouter.use(requireAuth, requireRole("ADMIN"));

/**
 * Permanently delete a product and its product-owned database records.
 * Orders themselves are preserved for financial history, but their